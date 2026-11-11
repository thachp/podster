//! `merge_task`: merging a task's reviewed commit into the repository's default branch (M5 step 7b, ADR 0009, which is
//! proposed). This is the one place Podster changes a default branch.
//!
//! Everything sits behind `MANAGED_REPOSITORIES`. With it off the route answers as one that doesn't exist.
//!
//! - **The command** ([`request`]) only records that a merge was asked for, with its event, outbox rows and idempotency
//!   record, in one transaction, and the room's alarm is armed. It never calls GitHub. Policy decides first, then
//!   `core::repo_merge`: a visible task, a `merge` grant that counts, a requester whose controlling person isn't the
//!   submitter's, an approval with a reviewed commit that Podster read for itself and hasn't seen change since.
//! - **The job** ([`Workspace::merge_upkeep`]) runs from the room's alarm, which may run it more than once, so each
//!   pass starts from what the room holds and what GitHub shows, and writes down what it is about to do before each
//!   call that changes anything there:
//!   1. the pass itself is counted, with the time of the next one, before anything else;
//!   2. authority is decided again from current rows, and the change must still stand as reviewed;
//!   3. the repository's protections are read back with the provisioning App and judged by provisioning's own
//!      comparison. Anything off degrades the link and ends the merge;
//!   4. the pull request and the default branch are read with the merge App. Its head, head repository, base, state and
//!      draft flag must be what was reviewed;
//!   5. `merge_marked_at` is written, then the review status is set on exactly the reviewed commit;
//!   6. `merge_called_at` is written, then the merge is asked for with that commit as `sha`, and the pull request and
//!      the default branch are read again. Only that read says what happened.
//! - **Dying anywhere is safe.** A pass that ends early changes nothing but the count. The next one does steps 2 to 4
//!   again before it marks or merges, so a merge is never made on authority or a head from an earlier pass. A status
//!   left on a commit by a pass that died lets nobody merge it: only the merge App can update the default branch, and
//!   this job is the only thing that holds its key. After `merge_called_at` the next pass reads first, and never asks
//!   for a second merge without having seen the pull request still open.
//! - **Tokens** are minted per call, for the one repository, checked to be exactly as narrow as asked, and revoked on
//!   every way out. None is stored, logged or put in an event or an error.
use super::*;
use crate::github::{
    Config, GitHubApp, MergeApp, MergeConfig, MergeSeen, MergeStepRead, Merger, Provider,
    PullAnswer,
};
use podster_core::provisioning::{job_backoff_ms, verify_ready, Expected};
use podster_core::repo_grants::Grant;
use podster_core::repo_merge::{
    check_change_standing, check_merge_authority, decide_merge_request, decide_merge_step,
    merge_attempt_allowed, merge_call, merge_request_allowed, merge_transition, Actor, Change,
    ChangeStanding, MergeAuthority, MergeAuthorized, MergeEvent, MergeFailure, MergeObserved,
    MergeRefusal, MergeStep, PullObservation, PullState, ReviewedBase,
};
use podster_core::repositories::{GrantAction, LinkStatus, MergeState, RequestState};
use podster_core::task_change::{pull_state_name, PullSeen};
use podster_policy::repositories::{authorize_merge, delegation_holder, GrantStanding};

const HOUR_MS: i64 = 60 * 60 * 1000;
/// How many merges one alarm works on. The rest wait for the next alarm.
const MAX_MERGES_PER_ALARM: usize = 2;
/// Who a recorded outcome is from: nobody in the room.
const SYSTEM: &str = "system";

fn refuse(status: u16, code: &'static str) -> ApiError {
    ApiError::api(status, code)
}

/// A refusal from the decision, as the API answers it.
fn refused(refusal: MergeRefusal) -> ApiError {
    match refusal {
        MergeRefusal::AccessRevoked => ApiError::access_revoked(),
        MergeRefusal::AgentDisconnected => ApiError::agent_disconnected(),
        MergeRefusal::Grant(_) | MergeRefusal::SelfMerge => refuse(403, refusal.code()),
        MergeRefusal::InvalidCommit => ApiError::invalid_argument(),
        _ => refuse(409, refusal.code()),
    }
}

/// What the route learned before the command's transaction. None of it comes from the request's body.
pub(super) struct Asked {
    /// The room's owner still holds their owner authority in the room's organization.
    pub(super) owner_holds: bool,
    /// The person who controls the caller: a person is their own, and an agent's is whoever linked its credential.
    pub(super) caller_person: Option<String>,
    /// The merge App is configured. Without it nothing is recorded.
    pub(super) configured: bool,
}

/// The requester's `merge` grant row that isn't revoked.
struct MergeGrant {
    id: String,
    delegated_by: String,
    repo_id: i64,
    expires_at: Option<i64>,
    revoked_at: Option<i64>,
}

/// The rows a merge decision reads, owned so the decision's inputs can borrow from them.
struct Inputs {
    task: Task,
    change: Option<Value>,
    grant: Option<MergeGrant>,
    owner: Option<String>,
    request: Option<RequestState>,
    /// The link's status, repository ID, default branch and whether it's public.
    link: Option<(Option<LinkStatus>, i64, String, bool)>,
}

fn read_inputs(sql: &SqlStorage, requester: &str, task_id: &str, now: i64) -> R<Option<Inputs>> {
    let Some(task) = load_task(sql, task_id)? else {
        return Ok(None);
    };
    let change = rows(
        sql,
        "SELECT * FROM task_change WHERE task_id = ?",
        vec![task_id.into()],
    )?
    .into_iter()
    .next();
    // A live grant on the room's own repository first, then any other live one, then the newest, as for a token.
    let grant = rows(sql, "SELECT id, delegated_by, provider_repo_id, expires_at, revoked_at FROM provider_grant WHERE principal_id = ?1 AND action = 'merge' AND revoked_at IS NULL
      ORDER BY (expires_at IS NULL OR expires_at > ?2) AND provider_repo_id IS (SELECT provider_repo_id FROM repo_link) DESC, (expires_at IS NULL OR expires_at > ?2) DESC, created_at DESC, id DESC", vec![requester.into(), now.into()])?
        .first()
        .and_then(|g| {
            Some(MergeGrant {
                id: text(&g["id"])?,
                delegated_by: text(&g["delegated_by"])?,
                repo_id: g["provider_repo_id"].as_i64()?,
                expires_at: g["expires_at"].as_i64(),
                revoked_at: g["revoked_at"].as_i64(),
            })
        });
    let owner = rows(sql, "SELECT owner_person_id FROM workspace", vec![])?
        .first()
        .and_then(|w| text(&w["owner_person_id"]));
    let request = rows(sql, "SELECT state FROM repo_request", vec![])?
        .first()
        .and_then(|r| r["state"].as_str().and_then(RequestState::from_name));
    let link = rows(
        sql,
        "SELECT status, provider_repo_id, default_branch, visibility FROM repo_link WHERE provider = 'github'",
        vec![],
    )?
    .first()
    .and_then(|l| {
        Some((
            l["status"].as_str().and_then(LinkStatus::from_name),
            l["provider_repo_id"].as_i64()?,
            text(&l["default_branch"])?,
            l["visibility"].as_str() == Some("public"),
        ))
    });
    Ok(Some(Inputs {
        task,
        change,
        grant,
        owner,
        request,
        link,
    }))
}

impl Inputs {
    fn grant<'a>(&'a self, requester: &'a str) -> Option<Grant<'a>> {
        self.grant.as_ref().map(|g| Grant {
            id: &g.id,
            principal: requester,
            provider_repo_id: g.repo_id,
            action: GrantAction::Merge,
            delegated_by: &g.delegated_by,
            expires_at: g.expires_at,
            revoked_at: g.revoked_at,
        })
    }

    /// Who made the approved submission, and the person who controlled them then. A change with no submitter on
    /// record names nobody, and core then refuses every requester as possibly the same.
    fn submitter(&self) -> (String, Option<String>) {
        let from = |name: &str| self.change.as_ref().and_then(|row| text(&row[name]));
        (
            from("submitter_id")
                .or_else(|| self.task.assignee.clone())
                .unwrap_or_default(),
            from("submitter_person"),
        )
    }

    fn standing(&self) -> ChangeStanding<'_> {
        let row = self.change.as_ref();
        ChangeStanding {
            reviewed_commit_sha: row.and_then(|row| row["reviewed_commit_sha"].as_str()),
            commit_changed: row.is_some_and(|row| row["commit_changed_at"].as_i64().is_some()),
            watched: row.is_none_or(|row| row["unwatched_at"].is_null()),
        }
    }

    fn merge_state(&self) -> MergeState {
        self.change
            .as_ref()
            .and_then(|row| row["merge_state"].as_str())
            .and_then(MergeState::from_name)
            .unwrap_or(MergeState::NotRequested)
    }
}

/// `POST tasks/{task}/merge`, in the command's transaction: `{ submission_no, commit_sha }`. Records that a merge was
/// asked for and nothing else. The job does the rest.
pub(super) fn request(
    sql: &SqlStorage,
    who: &Participant,
    task_id: &str,
    body: &Value,
    asked: &Asked,
    now: i64,
) -> R<Value> {
    let caller = &who.caller;
    let Some(inputs) = read_inputs(sql, &caller.id, task_id, now)? else {
        return Err(ApiError::task_not_found());
    };
    let grant = inputs.grant(&caller.id);
    let holder = inputs
        .owner
        .as_deref()
        .and_then(|owner| delegation_holder(owner, PrincipalKind::Person, asked.owner_holds));
    let link_repo_id = inputs.link.as_ref().map(|(_, id, _, _)| *id);
    let (submitter_id, submitter_person) = inputs.submitter();
    let submitter = Actor {
        id: &submitter_id,
        person: submitter_person.as_deref(),
    };
    // Policy first: whether the caller may know the task exists comes before anything about it is said.
    let policy = GrantStanding {
        grant: grant.as_ref(),
        link_repo_id: link_repo_id.unwrap_or(0),
        delegation_holder: holder,
        through_public_claim: public_claims::is_public_participant(sql, &caller.id)?,
        now,
    };
    if let Err(denial) = authorize_merge(
        caller,
        asked.caller_person.as_deref(),
        &inputs.task,
        &submitter,
        &policy,
    ) {
        // An unlinked room's grant check would say `repo_not_linked`, which the core decision says better.
        if !(link_repo_id.is_none()
            && matches!(denial, podster_policy::repositories::RepoDenial::Grant(_)))
        {
            return Err(repositories::denied(denial));
        }
    }
    let submission_no = body
        .get("submission_no")
        .and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n).ok())
        .ok_or_else(ApiError::invalid_argument)?;
    let commit_sha = body
        .get("commit_sha")
        .and_then(Value::as_str)
        .ok_or_else(ApiError::invalid_argument)?;
    let authority = MergeAuthority {
        task: &inputs.task,
        request: inputs.request,
        link: inputs.link.as_ref().and_then(|(status, _, _, _)| *status),
        link_repo_id,
        requester: Actor {
            id: &caller.id,
            person: asked.caller_person.as_deref(),
        },
        // `resolve_caller` found a current participant, and the API checked an agent's connection before the room saw
        // the request.
        requester_in_room: caller.role != Role::None,
        requester_connected: true,
        submitter,
        grant: grant.as_ref(),
        delegation_holder: holder,
        submission_no,
        commit_sha,
        now,
    };
    let merge_reason = inputs
        .change
        .as_ref()
        .and_then(|row| text(&row["merge_reason"]));
    let change = inputs.change.as_ref().map(|row| Change {
        provider_repo_id: int(&row["provider_repo_id"]),
        submission_no: u32::try_from(int(&row["submission_no"])).unwrap_or(0),
        reviewed_commit_sha: row["reviewed_commit_sha"].as_str(),
        merge_state: inputs.merge_state(),
        merge_reason: merge_reason.as_deref(),
    });
    decide_merge_request(&authority, change.as_ref()).map_err(refused)?;
    check_change_standing(&inputs.standing(), commit_sha).map_err(refused)?;
    let recent = rows(
        sql,
        "SELECT count(*) AS n FROM task_change WHERE merge_requested_at > ?",
        vec![(now - HOUR_MS).into()],
    )?
    .first()
    .map_or(0, |row| int(&row["n"]));
    if !merge_request_allowed(recent.clamp(0, i64::from(u32::MAX)) as u32) {
        return Err(refuse(429, "rate_limited"));
    }
    // Nothing is recorded that the job could never carry out.
    if !asked.configured {
        return Err(refuse(503, "merge_unavailable"));
    }
    // What an earlier request left of its mark and its call stays: a merge that request made, and that only shows now,
    // is still read as Podster's own.
    exec(
        sql,
        "UPDATE task_change SET merge_state = 'requested', merge_reason = NULL, merge_requested_by = ?1, merge_requester_person = ?2,
           merge_requested_at = ?3, merge_attempts = 0, merge_next_at = ?3, merge_step = 'requested', merge_finished_at = NULL, updated_at = ?3
         WHERE task_id = ?4",
        vec![
            caller.id.as_str().into(),
            asked.caller_person.as_deref().map_or(V::Null, V::from),
            now.into(),
            task_id.into(),
        ],
    )?;
    let told: Vec<String> = store::room_admins(sql)?
        .into_iter()
        .filter(|admin| admin != &caller.id)
        .collect();
    record_event(
        sql,
        MergeEvent::Requested.name(),
        &caller.id,
        Some(task_id),
        &Transition::NONE,
        told,
        now,
    )?;
    Ok(
        json!({ "task_id": task_id, "merge_state": MergeState::Requested.name(), "commit_sha": commit_sha, "submission_no": submission_no, "requested_at": now }),
    )
}

/// When the merge job next has work, for the room's alarm: the earliest pass due for a merge that's been asked for.
pub(super) fn next_due(sql: &SqlStorage, env: &Env, now: i64) -> R<Option<i64>> {
    if !provisioning::enabled(env, sql)? {
        return Ok(None);
    }
    Ok(rows(
        sql,
        "SELECT min(merge_next_at) AS due FROM task_change WHERE merge_state = 'requested'",
        vec![],
    )?
    .first()
    .and_then(|row| row["due"].as_i64())
    .map(|due| due.max(now + 10)))
}

/// Test builds only: a room holding this table with `at` in it stands for a Worker that died at that point of a pass.
fn dies(sql: &SqlStorage, at: &str) -> bool {
    #[cfg(feature = "failpoints")]
    {
        rows(
            sql,
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_merge_dies'",
            vec![],
        )
        .is_ok_and(|found| !found.is_empty())
            && rows(
                sql,
                "SELECT 1 AS dies FROM test_merge_dies WHERE at = ?",
                vec![at.into()],
            )
            .is_ok_and(|found| !found.is_empty())
    }
    #[cfg(not(feature = "failpoints"))]
    {
        let _ = (sql, at);
        false
    }
}

/// What a pass decided from current rows, before it calls anything.
struct Pass {
    authorized: MergeAuthorized,
    repo_id: i64,
    number: i64,
    default_branch: String,
    public: bool,
    reviewed_base_sha: Option<String>,
    /// A merge call may already have gone out for this change, in this pass's request or an earlier one.
    called: bool,
    /// This is the last pass allowed: it reads, and asks GitHub to change nothing.
    last: bool,
}

/// How a pass begins.
enum Begun {
    /// Nothing to do: the merge isn't asked for any more.
    Nothing,
    /// The merge ended here, with this reason.
    Ended,
    Go(Box<Pass>),
}

/// Counts the pass and decides authority again, in one transaction. A merge that no longer has authority ends here.
fn begin(sql: &SqlStorage, room: &str, task_id: &str, owner_holds: bool, now: i64) -> R<Begun> {
    let requester = rows(
        sql,
        "SELECT merge_requested_by, merge_requester_person, merge_attempts, merge_called_at, pr_number, submission_no, reviewed_base_sha
           FROM task_change WHERE task_id = ? AND merge_state = 'requested'",
        vec![task_id.into()],
    )?;
    let Some(row) = requester.first() else {
        return Ok(Begun::Nothing);
    };
    let requester_id = text(&row["merge_requested_by"]).unwrap_or_default();
    let requester_person = text(&row["merge_requester_person"]);
    let attempts = int(&row["merge_attempts"]).clamp(0, i64::from(u32::MAX)) as u32;
    let called = row["merge_called_at"].as_i64().is_some();
    let last = !merge_attempt_allowed(attempts);
    if last && !called {
        // Nothing was ever asked of GitHub that could have merged it, so there's nothing to read first.
        finish_failed(sql, room, task_id, MergeFailure::AttemptsExhausted, now)?;
        return Ok(Begun::Ended);
    }
    // The count and the next pass's time go down before anything else, so a pass that dies is still counted.
    let next = attempts.saturating_add(1);
    exec(
        sql,
        "UPDATE task_change SET merge_attempts = ?, merge_next_at = ?, merge_step = 'pass' WHERE task_id = ?",
        vec![
            i64::from(next).into(),
            (now + job_backoff_ms(next)).into(),
            task_id.into(),
        ],
    )?;
    // A room that was archived or suspended since the merge was asked for does nothing more on a repository.
    let closed = rows(sql, "SELECT status, suspended_at FROM workspace", vec![])?
        .first()
        .and_then(|room| {
            if room["status"].as_str() == Some(ARCHIVED) {
                Some(MergeFailure::RoomArchived)
            } else {
                room["suspended_at"]
                    .as_i64()
                    .map(|_| MergeFailure::RoomSuspended)
            }
        });
    if let Some(failure) = closed {
        finish_failed(sql, room, task_id, failure, now)?;
        return Ok(Begun::Ended);
    }
    let Some(inputs) = read_inputs(sql, &requester_id, task_id, now)? else {
        return Ok(Begun::Nothing);
    };
    let grant = inputs.grant(&requester_id);
    let holder = inputs
        .owner
        .as_deref()
        .and_then(|owner| delegation_holder(owner, PrincipalKind::Person, owner_holds));
    let (submitter_id, submitter_person) = inputs.submitter();
    let reviewed = inputs.standing().reviewed_commit_sha.map(str::to_string);
    let in_room = participant(sql, &requester_id)?.is_some();
    let authority = MergeAuthority {
        task: &inputs.task,
        request: inputs.request,
        link: inputs.link.as_ref().and_then(|(status, _, _, _)| *status),
        link_repo_id: inputs.link.as_ref().map(|(_, id, _, _)| *id),
        requester: Actor {
            id: &requester_id,
            person: requester_person.as_deref(),
        },
        // A disconnected agent is removed from the room, so being in it is being connected.
        requester_in_room: in_room,
        requester_connected: in_room,
        submitter: Actor {
            id: &submitter_id,
            person: submitter_person.as_deref(),
        },
        grant: grant.as_ref(),
        delegation_holder: holder,
        submission_no: u32::try_from(int(&row["submission_no"])).unwrap_or(0),
        commit_sha: reviewed.as_deref().unwrap_or_default(),
        now,
    };
    let decided = check_merge_authority(&authority).and_then(|authorized| {
        check_change_standing(&inputs.standing(), authorized.commit_sha()).map(|()| authorized)
    });
    let authorized = match decided {
        Ok(authorized) => authorized,
        Err(refusal) => {
            finish_failed(
                sql,
                room,
                task_id,
                MergeFailure::AuthorityLost(refusal),
                now,
            )?;
            return Ok(Begun::Ended);
        }
    };
    let Some((_, repo_id, default_branch, public)) = inputs.link else {
        return Ok(Begun::Nothing);
    };
    Ok(Begun::Go(Box::new(Pass {
        authorized,
        repo_id,
        number: int(&row["pr_number"]),
        default_branch,
        public,
        reviewed_base_sha: text(&row["reviewed_base_sha"]),
        called,
        last,
    })))
}

/// Records what the job is about to do, or has done, only while the merge is still the one this pass began with.
fn note(sql: &SqlStorage, task_id: &str, step: &'static str, set: &str, now: i64) -> R<bool> {
    exec(
        sql,
        &format!("UPDATE task_change SET merge_step = ?1, {set} WHERE task_id = ?3 AND merge_state = 'requested'"),
        vec![step.into(), now.into(), task_id.into()],
    )?;
    Ok(!rows(
        sql,
        "SELECT 1 AS still FROM task_change WHERE task_id = ? AND merge_state = 'requested' AND merge_step = ?",
        vec![task_id.into(), step.into()],
    )?
    .is_empty())
}

/// Who is told how a merge ended: the room's human owner and admins, and whoever asked, if they're still here.
fn told_of_outcome(sql: &SqlStorage, requester: &str) -> R<Vec<String>> {
    let mut told = store::room_admins(sql)?;
    if participant(sql, requester)?.is_some() {
        told.push(requester.to_string());
    }
    told.sort();
    told.dedup();
    Ok(told)
}

fn requester_of(sql: &SqlStorage, task_id: &str) -> R<String> {
    Ok(rows(
        sql,
        "SELECT merge_requested_by FROM task_change WHERE task_id = ?",
        vec![task_id.into()],
    )?
    .first()
    .and_then(|row| text(&row["merge_requested_by"]))
    .unwrap_or_default())
}

/// Ends a merge as failed, with its reason: state, an event of IDs and a reason code, and outbox rows, together. A
/// changed commit is also kept on the change for good, so no later request merges it.
fn finish_failed(
    sql: &SqlStorage,
    room: &str,
    task_id: &str,
    failure: MergeFailure,
    now: i64,
) -> R<()> {
    let from = rows(
        sql,
        "SELECT merge_state FROM task_change WHERE task_id = ?",
        vec![task_id.into()],
    )?
    .first()
    .and_then(|row| row["merge_state"].as_str().and_then(MergeState::from_name));
    let Some(MergeState::Failed) =
        from.and_then(|from| merge_transition(task_id, from, &MergeEvent::Failed))
    else {
        return Ok(());
    };
    let code = failure.code();
    exec(
        sql,
        "UPDATE task_change SET merge_state = 'failed', merge_reason = ?1, merge_finished_at = ?2, merge_next_at = NULL, merge_step = 'failed',
           commit_changed_at = CASE WHEN ?3 THEN coalesce(commit_changed_at, ?2) ELSE commit_changed_at END, updated_at = ?2
         WHERE task_id = ?4",
        vec![
            code.into(),
            now.into(),
            flag(failure.needs_follow_up()),
            task_id.into(),
        ],
    )?;
    let requester = requester_of(sql, task_id)?;
    store::record_event_about(
        sql,
        MergeEvent::Failed.name(),
        SYSTEM,
        Some(&requester),
        Some(task_id),
        &Transition {
            reason: Some(code),
            ..Transition::NONE
        },
        told_of_outcome(sql, &requester)?,
        now,
    )?;
    console_log!(
        "{}",
        json!({ "event": "merge.failed", "ws": room, "task": task_id, "reason": code })
    );
    Ok(())
}

/// Ends a merge as done. Only `proof`, which `core::decide_merge_step` gives for a pull request read as merged with the
/// default branch holding the reviewed commit, moves it there.
fn finish_succeeded(
    sql: &SqlStorage,
    room: &str,
    task_id: &str,
    proof: MergeObserved,
    pull: &PullSeen,
    now: i64,
) -> R<()> {
    let event = MergeEvent::Succeeded(proof);
    let from = rows(
        sql,
        "SELECT merge_state FROM task_change WHERE task_id = ?",
        vec![task_id.into()],
    )?
    .first()
    .and_then(|row| row["merge_state"].as_str().and_then(MergeState::from_name));
    let Some(MergeState::Succeeded) = from.and_then(|from| merge_transition(task_id, from, &event))
    else {
        return Ok(());
    };
    // A merged change isn't watched any more: its state says so.
    exec(
        sql,
        "UPDATE task_change SET merge_state = 'succeeded', merge_reason = NULL, merge_sha = ?1, merged_by_id = ?2, merge_finished_at = ?3,
           merge_next_at = NULL, merge_step = 'succeeded', pr_state = ?4, pr_observed_at = ?3, observed_head_sha = ?5, head_observed_at = ?3, updated_at = ?3
         WHERE task_id = ?6",
        vec![
            pull.merge_sha.as_deref().map_or(V::Null, V::from),
            pull.merged_by_id.map_or(V::Null, V::from),
            now.into(),
            pull_state_name(PullState::Merged).into(),
            pull.head_sha.as_str().into(),
            task_id.into(),
        ],
    )?;
    let requester = requester_of(sql, task_id)?;
    store::record_event_about(
        sql,
        event.name(),
        SYSTEM,
        Some(&requester),
        Some(task_id),
        &Transition::NONE,
        told_of_outcome(sql, &requester)?,
        now,
    )?;
    console_log!(
        "{}",
        json!({ "event": "merge.succeeded", "ws": room, "task": task_id })
    );
    Ok(())
}

/// What the job read, in the terms `core::decide_merge_step` judges.
fn observation<'a>(pull: &'a PullSeen, default_branch_has: Option<bool>) -> PullObservation<'a> {
    PullObservation {
        state: pull.state,
        // A base with no usable name is never the default branch.
        base_ref: pull.base_ref.as_deref().unwrap_or_default(),
        base_sha: &pull.base_sha,
        head_repo_id: pull.head_repo_id,
        head_sha: &pull.head_sha,
        default_branch_has_reviewed: default_branch_has,
    }
}

impl Workspace {
    /// The merge job, run by the room's alarm: one pass at each merge that's due, a couple an alarm.
    pub(super) async fn merge_upkeep(&self) -> R<()> {
        let sql = self.state.storage().sql();
        if !provisioning::enabled(&self.env, &sql)? {
            return Ok(());
        }
        let due: Vec<String> = rows(
            &sql,
            "SELECT task_id FROM task_change WHERE merge_state = 'requested' AND merge_next_at <= ? ORDER BY merge_next_at LIMIT ?",
            vec![now_ms().into(), (MAX_MERGES_PER_ALARM as i64).into()],
        )?
        .iter()
        .filter_map(|row| text(&row["task_id"]))
        .collect();
        if due.is_empty() {
            return Ok(());
        }
        let room = rows(&sql, "SELECT id FROM workspace", vec![])?
            .first()
            .and_then(|row| text(&row["id"]))
            .unwrap_or_default();
        for task_id in due {
            // Test builds only: a room can hold the job off entirely, so a test can look at a request before any pass.
            if dies(&sql, "start") {
                continue;
            }
            if let Err(error) = self.merge_pass(&room, &task_id).await {
                console_error!(
                    "{}",
                    json!({ "event": "merge.pass_failed", "ws": room, "task": task_id, "code": error.code().unwrap_or("internal_error") })
                );
            }
        }
        Ok(())
    }

    /// Whether the room's owner still holds their authority, from their `Principal`. `None` if it can't say.
    pub(super) async fn owner_holds(&self) -> Option<bool> {
        let sql = self.state.storage().sql();
        let room = rows(
            &sql,
            "SELECT owner_person_id, owner_org_id, owner_left_at, owner_since FROM workspace",
            vec![],
        )
        .ok()?;
        let room = room.first()?;
        match (text(&room["owner_person_id"]), text(&room["owner_org_id"])) {
            (Some(owner), Some(org)) if room["owner_left_at"].is_null() => {
                let since = room["owner_since"].as_i64().unwrap_or(0);
                principal::departed_since(&self.env, &owner, &org, since)
                    .await
                    .ok()
                    .map(|departed| !departed)
            }
            _ => Some(false),
        }
    }

    fn log_unrevoked<T>(&self, read: &MergeStepRead<T>, room: &str, task_id: &str) {
        if !read.revoked {
            console_error!(
                "{}",
                json!({ "event": "merge.token_unrevoked", "ws": room, "task": task_id })
            );
        }
    }

    fn log_waiting(&self, room: &str, task_id: &str, at: &'static str, status: u16) {
        console_error!(
            "{}",
            json!({ "event": "merge.waiting", "ws": room, "task": task_id, "at": at, "status": status })
        );
    }

    /// One pass at one merge. Every way out leaves the merge either ended or due another pass, already counted.
    async fn merge_pass(&self, room: &str, task_id: &str) -> R<()> {
        // The owner's standing is asked of their `Principal` first: a grant counts only while its giver holds the
        // delegation. If it can't say, the pass isn't made and isn't counted, and the alarm comes back.
        let Some(owner_holds) = self.owner_holds().await else {
            let (task, now) = (task_id.to_string(), now_ms());
            self.in_transaction(move |sql| {
                exec(
                    sql,
                    "UPDATE task_change SET merge_next_at = ? WHERE task_id = ? AND merge_state = 'requested'",
                    vec![(now + job_backoff_ms(1)).into(), task.as_str().into()],
                )
            })?;
            self.log_waiting(room, task_id, "standing", 0);
            return Ok(());
        };
        let begun = self.in_transaction({
            let (room, task) = (room.to_string(), task_id.to_string());
            move |sql| begin(sql, &room, &task, owner_holds, now_ms())
        })?;
        let Begun::Go(pass) = begun else {
            return Ok(());
        };
        let sql = self.state.storage().sql();
        let (Some(merge_config), Some(config)) = (
            self.merge_config(&sql),
            Config::from_env(&self.env).filter(|_| !pass.last),
        ) else {
            if pass.last {
                return self.last_pass(room, task_id, &pass).await;
            }
            self.log_waiting(room, task_id, "configuration", 0);
            return Ok(());
        };
        let merger = MergeApp::new(merge_config);
        // Readiness: the protections provisioning set, read back with the provisioning App, which alone sees who may
        // bypass them, and judged by provisioning's own comparison.
        let provider = GitHubApp::new(config);
        let expected = Expected {
            repo_id: pass.repo_id,
            org_id: provider.config().org_id,
            merge_app_id: provider.config().merge_app_id,
            public: pass.public,
        };
        let read_back = provider.read_back(pass.repo_id).await;
        if provider.release().await > 0 {
            console_error!(
                "{}",
                json!({ "event": "merge.token_unrevoked", "ws": room, "task": task_id })
            );
        }
        let observed = match read_back {
            Ok((observed, _)) => observed,
            Err(failure) => {
                self.log_waiting(room, task_id, "readiness", failure.status());
                return Ok(());
            }
        };
        if let Err(not_ready) = verify_ready(&expected, &observed) {
            let (room_id, task, repo_id) = (room.to_string(), task_id.to_string(), pass.repo_id);
            return self.in_transaction(move |sql| {
                let now = now_ms();
                // Nothing is marked or merged in a repository whose rules aren't the ones Podster set, and coding
                // work in the room stops until someone looks.
                exec(
                    sql,
                    "UPDATE repo_link SET status = 'degraded', status_reason = ?, updated_at = ? WHERE provider_repo_id = ? AND status = 'ready'",
                    vec![not_ready.code().into(), now.into(), repo_id.into()],
                )?;
                finish_failed(sql, &room_id, &task, MergeFailure::NotReady, now)
            });
        }
        // The pull request and the default branch, as they are now.
        let read = merger
            .observe(
                pass.repo_id,
                pass.number,
                pass.authorized.commit_sha(),
                &pass.default_branch,
            )
            .await;
        self.log_unrevoked(&read, room, task_id);
        let seen = match read.answer {
            Ok(seen) => seen,
            Err(failure) => {
                self.log_waiting(room, task_id, "read", failure.status());
                return Ok(());
            }
        };
        let Some(base_moved_from) = self.judge(room, task_id, &pass, seen, None).await? else {
            return Ok(());
        };
        // Mark: the intent first, then the status on exactly the reviewed commit, then that it was set.
        let marked = self.in_transaction({
            let task = task_id.to_string();
            move |sql| note(sql, &task, "mark", "merge_marked_at = ?2", now_ms())
        })?;
        if !marked || dies(&sql, "before_mark") {
            return Ok(());
        }
        let mark = merger
            .mark(pass.repo_id, pass.authorized.commit_sha())
            .await;
        self.log_unrevoked(&mark, room, task_id);
        if let Err(failure) = mark.answer {
            self.log_waiting(room, task_id, "mark", failure.status());
            return Ok(());
        }
        let noted = self.in_transaction({
            let task = task_id.to_string();
            move |sql| note(sql, &task, "marked", "merge_mark_set_at = ?2", now_ms())
        })?;
        if !noted || dies(&sql, "after_mark") {
            return Ok(());
        }
        // Merge: the intent and the base seen first, then the call, then what GitHub shows.
        let calling = self.in_transaction({
            let (task, base) = (task_id.to_string(), base_moved_from);
            move |sql| {
                exec(
                    sql,
                    "UPDATE task_change SET merge_base_sha = ? WHERE task_id = ? AND merge_state = 'requested'",
                    vec![base.as_str().into(), task.as_str().into()],
                )?;
                note(sql, &task, "merge", "merge_called_at = ?2", now_ms())
            }
        })?;
        if !calling {
            return Ok(());
        }
        let merged = merger
            .merge(
                pass.repo_id,
                pass.number,
                pass.authorized.commit_sha(),
                &pass.default_branch,
            )
            .await;
        self.log_unrevoked(&merged, room, task_id);
        if merged.failed_at_mint {
            // No token, so nothing was asked. The call is un-recorded, so a merge seen later isn't taken for this one.
            let task = task_id.to_string();
            self.in_transaction(move |sql| {
                exec(
                    sql,
                    "UPDATE task_change SET merge_called_at = NULL, merge_step = 'marked' WHERE task_id = ? AND merge_state = 'requested'",
                    vec![task.as_str().into()],
                )
            })?;
            self.log_waiting(room, task_id, "merge", 0);
            return Ok(());
        }
        if dies(&sql, "after_merge_call") {
            return Ok(());
        }
        let (status, after) = merged.answer;
        match after {
            Ok(seen) => {
                self.judge(room, task_id, &pass, seen, Some(status)).await?;
            }
            // The answer alone decides nothing. The next pass reads before it does anything else.
            Err(failure) => self.log_waiting(room, task_id, "read_after", failure.status()),
        }
        Ok(())
    }

    /// The merge App's configuration, or `None`. Test builds can stand for a deployment where it isn't set, and can
    /// override one room's variables by a table only a test can make, to show a misconfiguration refused end to end.
    pub(super) fn merge_config(&self, sql: &SqlStorage) -> Option<MergeConfig> {
        #[cfg(feature = "failpoints")]
        {
            let has = |table: &str| {
                rows(
                    sql,
                    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
                    vec![table.into()],
                )
                .is_ok_and(|found| !found.is_empty())
            };
            if has("test_no_merge_app") {
                return None;
            }
            if has("test_github_vars") {
                let overrides: std::collections::HashMap<String, String> =
                    rows(sql, "SELECT name, value FROM test_github_vars", vec![])
                        .unwrap_or_default()
                        .iter()
                        .filter_map(|r| Some((text(&r["name"])?, text(&r["value"])?)))
                        .collect();
                return MergeConfig::from_lookup(&|name: &str| {
                    overrides
                        .get(name)
                        .cloned()
                        .or_else(|| crate::github::lookup(&self.env, name))
                });
            }
        }
        #[cfg(not(feature = "failpoints"))]
        let _ = sql;
        MergeConfig::from_env(&self.env)
    }

    /// The last pass allowed, after a merge call went out at some point: it only reads. A merge that shows now is
    /// recorded, and anything else ends the request.
    async fn last_pass(&self, room: &str, task_id: &str, pass: &Pass) -> R<()> {
        let sql = self.state.storage().sql();
        let seen = match self.merge_config(&sql) {
            Some(config) => {
                let read = MergeApp::new(config)
                    .observe(
                        pass.repo_id,
                        pass.number,
                        pass.authorized.commit_sha(),
                        &pass.default_branch,
                    )
                    .await;
                self.log_unrevoked(&read, room, task_id);
                read.answer.ok()
            }
            None => None,
        };
        if let Some(seen) = seen {
            if self.judge(room, task_id, pass, seen, None).await?.is_none() {
                // Ended one way or the other, or the read said to read again, which a last pass can't.
                let still = rows(
                    &sql,
                    "SELECT 1 AS still FROM task_change WHERE task_id = ? AND merge_state = 'requested'",
                    vec![task_id.into()],
                )?;
                if still.is_empty() {
                    return Ok(());
                }
            }
        }
        let (room, task) = (room.to_string(), task_id.to_string());
        self.in_transaction(move |sql| {
            finish_failed(sql, &room, &task, MergeFailure::AttemptsExhausted, now_ms())
        })
    }

    /// Judges what was read of the pull request and the default branch, with the merge call's answer if one was just
    /// made (`Some(None)` is a call that got no answer). Ends the merge when the read settles it. Answers the base
    /// commit seen when the next thing to do is mark and merge, and `None` otherwise.
    async fn judge(
        &self,
        room: &str,
        task_id: &str,
        pass: &Pass,
        seen: MergeSeen,
        call: Option<Option<u16>>,
    ) -> R<Option<String>> {
        let finish = |failure: MergeFailure| -> R<Option<String>> {
            let (room, task) = (room.to_string(), task_id.to_string());
            self.in_transaction(move |sql| finish_failed(sql, &room, &task, failure, now_ms()))?;
            Ok(None)
        };
        let pull = match seen.pull {
            PullAnswer::Found(pull)
                if pull.number == pass.number && pull.repo_id == Some(pass.repo_id) =>
            {
                pull
            }
            // An answer about some other pull request is no answer.
            PullAnswer::Found(_) => {
                self.log_waiting(room, task_id, "read", 0);
                return Ok(None);
            }
            PullAnswer::Missing => return finish(MergeFailure::PullClosed),
        };
        // Merged before this job ever asked GitHub for a merge: someone else's, whatever commit it was of.
        if pull.state == PullState::Merged && !pass.called && call.is_none() {
            return finish(MergeFailure::MergedElsewhere);
        }
        let reviewed = ReviewedBase {
            default_branch: &pass.default_branch,
            base_sha: pass.reviewed_base_sha.as_deref(),
        };
        let step = decide_merge_step(
            &pass.authorized,
            &reviewed,
            &observation(&pull, seen.default_branch_has),
            call.map(merge_call),
        );
        match step {
            MergeStep::Succeeded(proof) => {
                let (room, task) = (room.to_string(), task_id.to_string());
                self.in_transaction(move |sql| {
                    finish_succeeded(sql, &room, &task, proof, &pull, now_ms())
                })?;
                Ok(None)
            }
            MergeStep::Failed(failure) => finish(failure),
            MergeStep::ReadAgain => {
                self.log_waiting(room, task_id, "merged_state", 0);
                Ok(None)
            }
            // A draft can't be merged, and a last pass asks for nothing.
            MergeStep::MarkAndMerge { .. } if pull.draft => finish(MergeFailure::PullDraft),
            MergeStep::MarkAndMerge { .. } if pass.last => Ok(None),
            MergeStep::MarkAndMerge { .. } => Ok(Some(pull.base_sha)),
        }
    }
}
