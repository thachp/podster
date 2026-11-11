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
use podster_core::provisioning::{
    decide_recheck, gone_look, job_backoff_ms, verify_ready, Expected, GoneLook, NotReady, Recheck,
    RecheckRead,
};
use podster_core::repo_grants::Grant;
use podster_core::repo_merge::{
    check_change_standing, check_merge_authority, decide_landed, decide_merge_request,
    decide_merge_step, merge_attempt_allowed, merge_call, merge_request_allowed, merge_transition,
    requestable_state, settle_unknown_from_watch, unknown_read_allowed, unknown_read_wait_ms,
    Actor, Change, ChangeStanding, Landed, MergeAuthority, MergeAuthorized, MergeEvent,
    MergeFailure, MergeObserved, MergeRefusal, MergeStep, PullObservation, PullState, ReviewedBase,
    WatchSettles,
};
use podster_core::repositories::{GrantAction, LinkStatus, MergeState, RequestState};
use podster_core::task_change::{pull_state_name, PullSeen};
use podster_policy::repositories::{authorize_merge, independent_review, GrantStanding};

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
        MergeRefusal::TaskHidden => ApiError::task_not_found(),
        MergeRefusal::Grant(_)
        | MergeRefusal::SelfMerge
        | MergeRefusal::SelfReview
        | MergeRefusal::ControllerDeparted
        | MergeRefusal::PublicParticipant
        | MergeRefusal::NotAllowed => refuse(403, refusal.code()),
        MergeRefusal::InvalidCommit => ApiError::invalid_argument(),
        _ => refuse(409, refusal.code()),
    }
}

/// What the route learned before the command's transaction. None of it comes from the request's body.
pub(super) struct Asked {
    /// Whether the giver of the caller's `merge` grant still holds the authority they gave it under.
    pub(super) giver: repositories::GiverRead,
    /// The person who controls the caller: a person is their own, and an agent's is whoever linked its credential.
    pub(super) caller_person: Option<String>,
    /// Whether that person still holds, as token issue asks: an agent's linker is still in the organization they linked
    /// it from, since then. A person's own standing is the room's `resolve_caller`.
    pub(super) controller_holds: bool,
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

    /// Who approved the reviewed commit, and the person who controlled them then, from the room's own record of the
    /// approval. `None` with no reviewed commit on record, which core refuses. An approval recorded before the room kept
    /// its reviewer names nobody, and the review counts as not independent: nothing is guessed.
    fn reviewer(&self) -> Option<(String, Option<String>)> {
        let row = self.change.as_ref()?;
        row["reviewed_commit_sha"].as_str()?;
        Some((
            text(&row["reviewer_id"]).unwrap_or_default(),
            text(&row["reviewer_person"]).filter(|_| row["reviewer_id"].is_string()),
        ))
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

/// Whoever asks for a merge, as the decision reads them: the room's view of them now, the person who controls them, and
/// whether that person still holds.
struct Requester<'a> {
    caller: &'a Caller,
    person: Option<&'a str>,
    controller_holds: bool,
}

/// Why a merge may not go on: the policy's refusal of who is asking, or core's of the rest.
enum Denied {
    Policy(podster_policy::repositories::RepoDenial),
    Core(MergeRefusal),
}

/// The one decision a merge rests on, from the room's rows in this transaction. `podster_policy` first, for who is
/// asking: whether they're in the room, can see the task, are there through a public claim now, aren't controlled by the
/// submitter's person, and hold a `merge` grant that counts, from a giver who still holds. Then `named` gives the
/// submission and commit the request names, and `decide` is `podster_core`'s decision on the rest, which also refuses a
/// requester whose controlling person has left. The request runs this, and every pass of the job runs it again before
/// the mark and before the merge call, so what they check can't drift apart.
fn decide_merge<T>(
    sql: &SqlStorage,
    requester: &Requester,
    inputs: &Inputs,
    giver: &repositories::GiverRead,
    now: i64,
    named: impl FnOnce() -> R<(u32, String)>,
    decide: impl FnOnce(&MergeAuthority) -> std::result::Result<T, MergeRefusal>,
) -> R<std::result::Result<T, Denied>> {
    let caller = requester.caller;
    let grant = inputs.grant(&caller.id);
    // The giver's standing, from the room's rows in this transaction and what their `Principal` said. If the giver
    // isn't the one that was asked about, nothing is decided on the answer.
    let holder = match &grant {
        Some(g) => repositories::standing_giver(sql, g.delegated_by, giver)?
            .map_err(|_| standing_unknown())?,
        None => None,
    };
    let link_repo_id = inputs.link.as_ref().map(|(_, id, _, _)| *id);
    let (submitter_id, submitter_person) = inputs.submitter();
    let submitter = Actor {
        id: &submitter_id,
        person: submitter_person.as_deref(),
    };
    // Policy first: whether the caller may know the task exists comes before anything about it is said.
    let standing = GrantStanding {
        grant: grant.as_ref(),
        link_repo_id: link_repo_id.unwrap_or(0),
        delegation_holder: holder,
        through_public_claim: public_claims::is_public_participant(sql, &caller.id)?,
        now,
    };
    match authorize_merge(
        caller,
        requester.person,
        &inputs.task,
        &submitter,
        &standing,
    ) {
        // The approving review must be independent of the submitter (review A1), decided only for a caller who may
        // otherwise merge, so nobody else learns anything about the review.
        Ok(()) => {
            let reviewer = inputs.reviewer();
            let reviewer = reviewer.as_ref().map(|(id, person)| Actor {
                id,
                person: person.as_deref(),
            });
            if let Err(denial) = independent_review(reviewer.as_ref(), &submitter) {
                return Ok(Err(Denied::Policy(denial)));
            }
        }
        // An unlinked room's grant check would say `repo_not_linked`, which the core decision says better.
        Err(podster_policy::repositories::RepoDenial::Grant(_)) if link_repo_id.is_none() => {}
        Err(denial) => return Ok(Err(Denied::Policy(denial))),
    }
    let (submission_no, commit_sha) = named()?;
    // The room resolved a current participant, or found none. A disconnected agent is removed from the room, so being
    // in it is being connected, and the API checked an agent's connection before the room saw a request.
    let in_room = caller.role != Role::None;
    let authority = MergeAuthority {
        task: &inputs.task,
        request: inputs.request,
        link: inputs.link.as_ref().and_then(|(status, _, _, _)| *status),
        link_repo_id,
        requester: Actor {
            id: &caller.id,
            person: requester.person,
        },
        requester_in_room: in_room,
        requester_connected: in_room,
        requester_controller_holds: requester.controller_holds,
        submitter,
        grant: grant.as_ref(),
        delegation_holder: holder,
        submission_no,
        commit_sha: &commit_sha,
        now,
    };
    Ok(decide(&authority).map_err(Denied::Core))
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
    let merge_reason = inputs
        .change
        .as_ref()
        .and_then(|row| text(&row["merge_reason"]));
    let change = inputs.change.as_ref().map(|row| Change {
        provider_repo_id: int(&row["provider_repo_id"]),
        submission_no: u32::try_from(int(&row["submission_no"])).unwrap_or(0),
        reviewed_commit_sha: row["reviewed_commit_sha"].as_str(),
        // One whose outcome the job stopped reading for may be asked for again, as core has it.
        merge_state: requestable_state(
            inputs.merge_state(),
            row["merge_step"].as_str() == Some(UNKNOWN_FINAL),
        ),
        merge_reason: merge_reason.as_deref(),
    });
    let requester = Requester {
        caller,
        person: asked.caller_person.as_deref(),
        controller_holds: asked.controller_holds,
    };
    // The contract takes these two fields and no other: nothing here can name a repository or a pull request. Read
    // after the policy, so someone who may not know of the task learns nothing from a malformed body either.
    let named = || -> R<(u32, String)> {
        if body.as_object().is_none_or(|fields| {
            fields
                .keys()
                .any(|name| name != "submission_no" && name != "commit_sha")
        }) {
            return Err(ApiError::invalid_argument());
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
        Ok((submission_no, commit_sha.to_string()))
    };
    let decided = decide_merge(
        sql,
        &requester,
        &inputs,
        &asked.giver,
        now,
        named,
        |authority| {
            decide_merge_request(authority, change.as_ref())?;
            check_change_standing(&inputs.standing(), authority.commit_sha)?;
            Ok((authority.submission_no, authority.commit_sha.to_string()))
        },
    )?;
    let (submission_no, commit_sha) = match decided {
        Ok(named) => named,
        Err(Denied::Policy(denial)) => return Err(repositories::denied(denial)),
        Err(Denied::Core(refusal)) => return Err(refused(refusal)),
    };
    // Every request is logged and counts: for the room this hour, and for the task for good. Asking again never
    // resets either, and the log is kept.
    let count = |filter: &str, bindings: Vec<V>| -> R<u32> {
        Ok(rows(
            sql,
            &format!("SELECT count(*) AS n FROM merge_request WHERE {filter}"),
            bindings,
        )?
        .first()
        .map_or(0, |row| int(&row["n"]).clamp(0, i64::from(u32::MAX)) as u32))
    };
    let this_hour = count("at > ?", vec![(now - HOUR_MS).into()])?;
    let for_task = count("task_id = ?", vec![task_id.into()])?;
    if let Err(limit) = merge_request_allowed(this_hour, for_task) {
        return Err(refuse(429, limit.code()));
    }
    // Nothing is recorded that the job could never carry out.
    if !asked.configured {
        return Err(refuse(503, "merge_unavailable"));
    }
    exec(
        sql,
        "INSERT INTO merge_request (at, task_id) VALUES (?, ?)",
        vec![now.into(), task_id.into()],
    )?;
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
        "SELECT min(merge_next_at) AS due FROM task_change WHERE merge_state IN ('requested', 'outcome_unknown')",
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

/// What a merge is of, from the room's own rows: the repository, the pull request, and the commit review recorded.
#[derive(Clone)]
struct Target {
    repo_id: i64,
    number: i64,
    default_branch: String,
    public: bool,
    commit: String,
    reviewed_base_sha: Option<String>,
}

fn target(sql: &SqlStorage, task_id: &str) -> R<Option<Target>> {
    Ok(rows(
        sql,
        "SELECT c.provider_repo_id, c.pr_number, c.reviewed_commit_sha, c.reviewed_base_sha, l.default_branch, l.visibility
           FROM task_change c JOIN repo_link l ON l.provider_repo_id = c.provider_repo_id WHERE c.task_id = ?",
        vec![task_id.into()],
    )?
    .first()
    .and_then(|row| {
        Some(Target {
            repo_id: row["provider_repo_id"].as_i64()?,
            number: row["pr_number"].as_i64()?,
            default_branch: text(&row["default_branch"])?,
            public: row["visibility"].as_str() == Some("public"),
            commit: text(&row["reviewed_commit_sha"])?,
            reviewed_base_sha: text(&row["reviewed_base_sha"]),
        })
    }))
}

/// What the room learned, before a pass's transaction, about whether the person who controls whoever asked for the
/// merge still holds: an agent's linker, or a person themselves, still in the organization the requester is in the room
/// through, since the merge was asked for. At the request the gateway refused a credential whose linker had left, and
/// the room a person who had, so this asks only about the time since. Never taken from a request.
#[derive(Clone, Debug)]
pub(super) struct ControllerRead {
    /// Whoever asked, and the person on record as controlling them, when this was read.
    requester: String,
    person: Option<String>,
    holds: bool,
}

/// Everything a pass asks other objects before it decides authority in a transaction.
#[derive(Clone, Debug)]
pub(super) struct JobReads {
    giver: repositories::GiverRead,
    controller: ControllerRead,
}

/// Whether the merge may go on, decided from the rows as they are now: the room still open, then [`decide_merge`], the
/// same decision the request made, for whoever asked, with the change still standing as reviewed. `None` when no merge
/// is asked for any more. Run when a pass begins and again in the transactions that record the intent to mark and the
/// intent to merge, so a revoke, a removal, a narrowed access, a public claim, a controlling person who left, an archive
/// or a suspension that commits while GitHub is answering is honoured before the next call.
fn authority(
    sql: &SqlStorage,
    task_id: &str,
    reads: &JobReads,
    now: i64,
) -> R<Option<std::result::Result<MergeAuthorized, MergeFailure>>> {
    let asked = rows(
        sql,
        "SELECT merge_requested_by, merge_requester_person, submission_no FROM task_change WHERE task_id = ? AND merge_state = 'requested'",
        vec![task_id.into()],
    )?;
    let Some(row) = asked.first() else {
        return Ok(None);
    };
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
        return Ok(Some(Err(failure)));
    }
    let requester_id = text(&row["merge_requested_by"]).unwrap_or_default();
    let requester_person = text(&row["merge_requester_person"]);
    // What was read was about this requester and this person, or nothing is decided on it: the pass waits.
    if reads.controller.requester != requester_id || reads.controller.person != requester_person {
        return Err(standing_unknown());
    }
    let Some(inputs) = read_inputs(sql, &requester_id, task_id, now)? else {
        return Ok(None);
    };
    let caller = caller_now(sql, &requester_id)?;
    let requester = Requester {
        caller: &caller,
        person: requester_person.as_deref(),
        controller_holds: reads.controller.holds,
    };
    let submission_no = u32::try_from(int(&row["submission_no"])).unwrap_or(0);
    let reviewed = inputs
        .standing()
        .reviewed_commit_sha
        .unwrap_or_default()
        .to_string();
    let decided = decide_merge(
        sql,
        &requester,
        &inputs,
        &reads.giver,
        now,
        || Ok((submission_no, reviewed)),
        |authority| {
            check_merge_authority(authority).and_then(|authorized| {
                check_change_standing(&inputs.standing(), authorized.commit_sha())
                    .map(|()| authorized)
            })
        },
    )?;
    Ok(Some(decided.map_err(|denied| {
        MergeFailure::AuthorityLost(match denied {
            Denied::Policy(denial) => denial.as_merge_refusal(),
            Denied::Core(refusal) => refusal,
        })
    })))
}

/// The giver's standing couldn't be decided: their `Principal` couldn't say, or the grant's giver isn't the one asked about.
fn standing_unknown() -> ApiError {
    ApiError::api(503, STANDING_UNKNOWN)
}

const STANDING_UNKNOWN: &str = "standing_unknown";

/// A pass that may go on to GitHub.
struct Pass {
    authorized: MergeAuthorized,
    target: Target,
    /// A merge call was already on record when this pass began, from this request or an earlier one.
    called: bool,
}

/// How a pass begins.
enum Begun {
    /// Nothing to do: the merge isn't asked for any more, or it ended here.
    Nothing,
    /// Counted, and nothing more this time: the standing of the grant's giver couldn't be read.
    Wait,
    /// The merge is to end with this failure, and a merge call is on record: GitHub is read first, and what it shows
    /// is what's recorded.
    Observe(Target, Ending),
    Go(Box<Pass>),
}

/// Counts the pass and decides authority again, in one transaction. `giver` is `None` when the `Principal` of the
/// grant's giver couldn't say.
fn begin(
    sql: &SqlStorage,
    room: &str,
    task_id: &str,
    reads: Option<JobReads>,
    now: i64,
) -> R<Begun> {
    let asked = rows(
        sql,
        "SELECT merge_attempts, merge_called_at FROM task_change WHERE task_id = ? AND merge_state = 'requested'",
        vec![task_id.into()],
    )?;
    let Some(row) = asked.first() else {
        return Ok(Begun::Nothing);
    };
    let attempts = int(&row["merge_attempts"]).clamp(0, i64::from(u32::MAX)) as u32;
    let called = row["merge_called_at"].as_i64().is_some();
    let last = !merge_attempt_allowed(attempts);
    // The count and the next pass's time go down before anything else, so a pass that dies, or waits, is still counted.
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
    let target = target(sql, task_id)?;
    // Once a call has gone out, nothing ends the merge without a read of what that call did.
    let end = |failure: MergeFailure| -> R<Begun> {
        match target.clone().filter(|_| called) {
            Some(target) => Ok(Begun::Observe(target, failure.into())),
            None => {
                finish_failed(sql, room, task_id, failure, now)?;
                Ok(Begun::Nothing)
            }
        }
    };
    if last {
        return end(MergeFailure::AttemptsExhausted);
    }
    let Some(reads) = reads else {
        return Ok(Begun::Wait);
    };
    let decided = match authority(sql, task_id, &reads, now) {
        // The giver changed since they were asked about: counted, and asked again next time.
        Err(error) if error.code() == Some(STANDING_UNKNOWN) => return Ok(Begun::Wait),
        decided => decided?,
    };
    match decided {
        None => Ok(Begun::Nothing),
        Some(Err(failure)) => end(failure),
        Some(Ok(authorized)) => match target {
            Some(target) => Ok(Begun::Go(Box::new(Pass {
                authorized,
                target,
                called,
            }))),
            None => Ok(Begun::Nothing),
        },
    }
}

/// What recording an intent came to.
enum Intent {
    Go,
    /// The merge isn't asked for any more.
    Gone,
    /// A standing read before the transaction no longer answers for the rows in it. Nothing was recorded.
    Wait,
    /// Authority, the change's standing or the room no longer holds. Nothing was recorded.
    Lost(MergeFailure),
}

/// Records what the job is about to ask of GitHub, in a transaction that first decides authority again from current
/// rows. `set` names the columns the intent writes, with `?2` the time and `?4` the base commit seen.
#[allow(clippy::too_many_arguments)]
fn intend(
    sql: &SqlStorage,
    task_id: &str,
    pass: &Pass,
    reads: &JobReads,
    step: &'static str,
    set: &str,
    base_sha: &str,
    now: i64,
) -> R<Intent> {
    let decided = match authority(sql, task_id, reads, now) {
        // The giver or the requester's controller changed since they were asked about: nothing is recorded, and the
        // pass stops here as it does when they can't be read.
        Err(error) if error.code() == Some(STANDING_UNKNOWN) => return Ok(Intent::Wait),
        decided => decided?,
    };
    match decided {
        None => Ok(Intent::Gone),
        Some(Err(failure)) => Ok(Intent::Lost(failure)),
        // The same commit this pass read the pull request for, and no other.
        Some(Ok(authorized)) if authorized != pass.authorized => Ok(Intent::Lost(
            MergeFailure::AuthorityLost(MergeRefusal::CommitChanged),
        )),
        Some(Ok(_)) => {
            exec(
                sql,
                &format!("UPDATE task_change SET merge_step = ?1, {set} WHERE task_id = ?3 AND merge_state = 'requested'"),
                // Only the merge's intent writes the base commit seen.
                if set.contains("?4") {
                    vec![step.into(), now.into(), task_id.into(), base_sha.into()]
                } else {
                    vec![step.into(), now.into(), task_id.into()]
                },
            )?;
            Ok(Intent::Go)
        }
    }
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

fn merge_state_of(sql: &SqlStorage, task_id: &str) -> R<Option<MergeState>> {
    Ok(rows(
        sql,
        "SELECT merge_state FROM task_change WHERE task_id = ?",
        vec![task_id.into()],
    )?
    .first()
    .and_then(|row| row["merge_state"].as_str().and_then(MergeState::from_name)))
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
    fail_with(sql, room, task_id, &Ending::from(failure), now)
}

/// How a merge is to end as failed: its reason code, and whether it's a changed commit, which is kept for good.
#[derive(Clone)]
struct Ending {
    code: String,
    follow_up: bool,
}

impl From<MergeFailure> for Ending {
    fn from(failure: MergeFailure) -> Ending {
        Ending {
            code: failure.code().to_string(),
            follow_up: failure.needs_follow_up(),
        }
    }
}

/// The step recorded once the job has stopped reading for a merge whose outcome isn't known.
const UNKNOWN_FINAL: &str = "outcome_unknown_final";

/// Records that a merge call went out, the merge was about to end as `pending`, and GitHub couldn't be read to see what
/// the call did. Not an end: the job keeps reading, and the first read that works settles it, as succeeded if the call
/// merged the reviewed commit and as failed with `pending` otherwise. Said once, with its event.
fn finish_unknown(
    sql: &SqlStorage,
    room: &str,
    task_id: &str,
    pending: &Ending,
    now: i64,
) -> R<()> {
    let from = merge_state_of(sql, task_id)?;
    match from.and_then(|from| merge_transition(task_id, from, &MergeEvent::OutcomeUnknown)) {
        Some(MergeState::OutcomeUnknown) => {}
        // Already unknown, and another read couldn't be made: it's counted, the next one waits longer, and past the
        // cap, or in a room that's archived or suspended, the job stops reading. The outcome stays recorded as
        // unknown, and a person asking for the merge again begins with a read.
        _ => {
            let reads = rows(
                sql,
                "SELECT merge_attempts FROM task_change WHERE task_id = ? AND merge_state = 'outcome_unknown'",
                vec![task_id.into()],
            )?
            .first()
            .map_or(0, |row| int(&row["merge_attempts"]).clamp(0, 64) as u32)
            .saturating_add(1);
            if unknown_read_allowed(reads, room_open(sql)?) {
                return exec(
                    sql,
                    "UPDATE task_change SET merge_attempts = ?, merge_next_at = ? WHERE task_id = ? AND merge_state = 'outcome_unknown'",
                    vec![
                        i64::from(reads).into(),
                        (now + unknown_read_wait_ms(reads)).into(),
                        task_id.into(),
                    ],
                );
            }
            return end_unknown_reads(sql, room, task_id, now);
        }
    }
    exec(
        sql,
        "UPDATE task_change SET merge_state = 'outcome_unknown', merge_reason = ?1, merge_attempts = 0, merge_next_at = ?2, merge_step = 'outcome_unknown', updated_at = ?3 WHERE task_id = ?4",
        vec![
            pending.code.as_str().into(),
            (now + unknown_read_wait_ms(0)).into(),
            now.into(),
            task_id.into(),
        ],
    )?;
    let requester = requester_of(sql, task_id)?;
    store::record_event_about(
        sql,
        MergeEvent::OutcomeUnknown.name(),
        SYSTEM,
        Some(&requester),
        Some(task_id),
        &Transition::NONE,
        told_of_outcome(sql, &requester)?,
        now,
    )?;
    console_log!(
        "{}",
        json!({ "event": "merge.outcome_unknown", "ws": room, "task": task_id })
    );
    Ok(())
}

/// Whether the room is neither archived nor suspended.
fn room_open(sql: &SqlStorage) -> R<bool> {
    Ok(
        rows(sql, "SELECT status, suspended_at FROM workspace", vec![])?
            .first()
            .is_some_and(|room| {
                room["status"].as_str() != Some(ARCHIVED) && room["suspended_at"].is_null()
            }),
    )
}

/// Stops the job reading for a merge whose outcome isn't known: no next read, the step says so, and one event. The
/// state stays `outcome_unknown`. Nothing is claimed either way.
fn end_unknown_reads(sql: &SqlStorage, room: &str, task_id: &str, now: i64) -> R<()> {
    exec(
        sql,
        "UPDATE task_change SET merge_next_at = NULL, merge_step = ?, updated_at = ? WHERE task_id = ? AND merge_state = 'outcome_unknown' AND merge_step <> ?",
        vec![UNKNOWN_FINAL.into(), now.into(), task_id.into(), UNKNOWN_FINAL.into()],
    )?;
    let requester = requester_of(sql, task_id)?;
    store::record_event_about(
        sql,
        "merge.outcome_unknown_final",
        SYSTEM,
        Some(&requester),
        Some(task_id),
        &Transition::NONE,
        told_of_outcome(sql, &requester)?,
        now,
    )?;
    console_log!(
        "{}",
        json!({ "event": "merge.outcome_unknown_final", "ws": room, "task": task_id })
    );
    Ok(())
}

fn fail_with(sql: &SqlStorage, room: &str, task_id: &str, ending: &Ending, now: i64) -> R<()> {
    let from = merge_state_of(sql, task_id)?;
    let Some(MergeState::Failed) =
        from.and_then(|from| merge_transition(task_id, from, &MergeEvent::Failed))
    else {
        return Ok(());
    };
    let code = ending.code.as_str();
    exec(
        sql,
        "UPDATE task_change SET merge_state = 'failed', merge_reason = ?1, merge_finished_at = ?2, merge_next_at = NULL, merge_step = 'failed',
           commit_changed_at = CASE WHEN ?3 THEN coalesce(commit_changed_at, ?2) ELSE commit_changed_at END, updated_at = ?2
         WHERE task_id = ?4",
        vec![
            code.into(),
            now.into(),
            flag(ending.follow_up),
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
    let from = merge_state_of(sql, task_id)?;
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

/// Sets a ready link `degraded`, with the reason and an event for the room's owner and admins. Only for a definite
/// difference from what provisioning set. Coding work in the room stops until an operator has rechecked it.
pub(super) fn degrade(sql: &SqlStorage, repo_id: i64, code: &'static str, now: i64) -> R<()> {
    let was_ready = !rows(
        sql,
        "SELECT 1 AS ready FROM repo_link WHERE provider_repo_id = ? AND status = 'ready'",
        vec![repo_id.into()],
    )?
    .is_empty();
    if !was_ready {
        return Ok(());
    }
    exec(
        sql,
        "UPDATE repo_link SET status = 'degraded', status_reason = ?, updated_at = ? WHERE provider_repo_id = ? AND status = 'ready'",
        vec![code.into(), now.into(), repo_id.into()],
    )?;
    // Every token agents hold on it is marked for revocation in this same transaction (the M5 security review's F2).
    store::mark_stale_repo_tokens(sql, now)?;
    record_event(
        sql,
        "repository.degraded",
        SYSTEM,
        None,
        &Transition {
            reason: Some(code),
            ..Transition::NONE
        },
        store::room_admins(sql)?,
        now,
    )
}

/// What a read-back of the repository's protections came to.
pub(super) enum Readiness {
    Ready,
    /// No definite answer: no configuration, no reply, a server error, a limit, or a reply that couldn't be read. It
    /// says nothing about the repository, so it never degrades a link or ends a merge.
    CouldNotRead(u16),
    /// A definite difference from what provisioning set, with its reason code. Someone with admin rights touched the
    /// repository, so a person should look.
    Mismatch(&'static str),
}

/// The Worker's call for an operator's recheck of a degraded link. Reached only from `crate::moderation`, which has
/// checked the operator.
pub(crate) const INTERNAL_REPOSITORY_RECHECK: &str = "/internal/operator-repository-recheck";

/// The reason recorded when the default branch GitHub reports isn't the one the link holds.
const DEFAULT_BRANCH_CHANGED: &str = "default_branch_changed";

impl Workspace {
    /// Reads the repository's protections back with the provisioning App, which alone sees who may bypass them, and
    /// judges them with provisioning's own comparison. It also compares the default branch GitHub reports with the one
    /// the link holds: the rules protect whatever the default branch is now, so a merge into the stored name after
    /// the default was changed would be into an unprotected branch. The one readiness check, for the merge job and for
    /// an operator's recheck. At provisioning there's no stored branch yet: the link takes the one this same read reports.
    pub(super) async fn readiness(
        &self,
        repo_id: i64,
        public: bool,
        default_branch: &str,
        room: &str,
    ) -> Readiness {
        let Some(config) = Config::from_env(&self.env) else {
            return Readiness::CouldNotRead(0);
        };
        let provider = GitHubApp::new(config);
        let expected = Expected {
            repo_id,
            org_id: provider.config().org_id,
            merge_app_id: provider.config().merge_app_id,
            public,
        };
        let read_back = provider.read_back(repo_id).await;
        if provider.release().await > 0 {
            console_error!(
                "{}",
                json!({ "event": "merge.token_unrevoked", "ws": room })
            );
        }
        let verdict = match read_back {
            Err(failure) => Readiness::CouldNotRead(failure.status()),
            Ok((observed, described)) => match verify_ready(&expected, &observed) {
                Err(not_ready) => Readiness::Mismatch(not_ready.code()),
                Ok(()) if described.default_branch != default_branch => {
                    Readiness::Mismatch(DEFAULT_BRANCH_CHANGED)
                }
                Ok(()) => Readiness::Ready,
            },
        };
        // "Gone" takes two definite answers a minute apart (`core::gone_look`); any read that finds it clears the first.
        let gone =
            matches!(verdict, Readiness::Mismatch(code) if code == NotReady::RepositoryGone.code());
        let look = self.in_transaction(move |sql| {
            let now = now_ms();
            if !gone {
                // Anything but "gone" again clears a first sighting, a read that couldn't be made included: the confirming
                // look either degrades or clears, so a pending sighting costs at most one more read.
                exec(sql, "UPDATE repo_link SET gone_seen_at = NULL WHERE provider_repo_id = ? AND gone_seen_at IS NOT NULL", vec![repo_id.into()])?;
                return Ok(None);
            }
            let first = rows(sql, "SELECT gone_seen_at FROM repo_link WHERE provider_repo_id = ?", vec![repo_id.into()])?
                .first()
                .and_then(|row| row["gone_seen_at"].as_i64());
            let look = gone_look(first, now);
            if look == GoneLook::FirstSeen {
                exec(sql, "UPDATE repo_link SET gone_seen_at = ? WHERE provider_repo_id = ?", vec![now.into(), repo_id.into()])?;
            }
            Ok(Some(look))
        });
        match (verdict, look) {
            (verdict, Ok(None) | Ok(Some(GoneLook::Confirmed))) => verdict,
            (_, Ok(Some(GoneLook::FirstSeen | GoneLook::TooSoon)) | Err(_)) => {
                Readiness::CouldNotRead(404)
            }
        }
    }

    /// An operator's recheck of a degraded link, `{ operator, key }` (reached only from `crate::moderation`, which has
    /// run policy on the verified caller). The same read-back as the merge job's, then `core::decide_recheck`: only a
    /// degraded link read back exactly right becomes `ready`. A command: the link, its event and outbox rows and the
    /// idempotency record commit in one transaction, and the same key answers the same again. Nothing recovers by itself.
    pub(super) async fn operator_recheck(&self, mut req: Request) -> R<Value> {
        let sql = self.state.storage().sql();
        if !store::is_initialized(&sql)? {
            return Err(ApiError::workspace_not_found());
        }
        self.migrate_if_needed()?;
        if !provisioning::enabled(&self.env, &sql)? {
            return Err(ApiError::not_found());
        }
        let body: Value =
            serde_json::from_str(&req.text().await?).map_err(|_| ApiError::invalid_argument())?;
        let (Some(operator), Some(key)) = (text(&body["operator"]), text(&body["key"])) else {
            return Err(ApiError::invalid_argument());
        };
        let hash = format!("{:x}", Sha256::digest(b"POST repository recheck"));
        if let Some(answer) = stored_answer(&sql, &operator, &key, &hash, now_ms())? {
            return Ok(answer);
        }
        let found = rows(
            &sql,
            "SELECT provider_repo_id, default_branch, visibility, status, status_reason FROM repo_link WHERE provider = 'github'",
            vec![],
        )?;
        let Some(link) = found.first() else {
            return Err(refuse(409, "repo_not_ready"));
        };
        let Some(status) = link["status"].as_str().and_then(LinkStatus::from_name) else {
            return Err(ApiError::internal("unknown link status"));
        };
        let repo_id = int(&link["provider_repo_id"]);
        // A degraded link is read to restore it, and a ready one to degrade it on a definite difference. A suspended one
        // isn't read: the decision is the same whatever GitHub says.
        let read = if matches!(status, LinkStatus::Degraded | LinkStatus::Ready) {
            let room = rows(&sql, "SELECT id FROM workspace", vec![])?
                .first()
                .and_then(|row| text(&row["id"]))
                .unwrap_or_default();
            Some(
                match self
                    .readiness(
                        repo_id,
                        link["visibility"].as_str() == Some("public"),
                        link["default_branch"].as_str().unwrap_or_default(),
                        &room,
                    )
                    .await
                {
                    Readiness::Ready => RecheckRead::ExactlyRight,
                    Readiness::Mismatch(code) => RecheckRead::Differs(code),
                    Readiness::CouldNotRead(_) => RecheckRead::CouldNotRead,
                },
            )
        } else {
            None
        };
        let unchanged = json!({ "status": status.name(), "reason": link["status_reason"] });
        self.in_transaction(move |sql| {
            let now = now_ms();
            // The link as it is now, in case it changed while GitHub was answering.
            let current = rows(sql, "SELECT status FROM repo_link WHERE provider_repo_id = ?", vec![repo_id.into()])?
                .first()
                .and_then(|row| row["status"].as_str().and_then(LinkStatus::from_name));
            let answer = match decide_recheck(current.unwrap_or(status), read.filter(|_| current == Some(status))) {
                Recheck::Unchanged => unchanged,
                Recheck::Unavailable => return Err(refuse(502, "provider_unavailable")),
                Recheck::Degrade(code) => {
                    degrade(sql, repo_id, code, now)?;
                    json!({ "status": LinkStatus::Degraded.name(), "reason": code })
                }
                Recheck::StillDegraded(code) => {
                    exec(
                        sql,
                        "UPDATE repo_link SET status_reason = ?, updated_at = ? WHERE provider_repo_id = ? AND status = 'degraded'",
                        vec![code.into(), now.into(), repo_id.into()],
                    )?;
                    json!({ "status": LinkStatus::Degraded.name(), "reason": code })
                }
                Recheck::MakeReady => {
                    exec(
                        sql,
                        "UPDATE repo_link SET status = 'ready', status_reason = NULL, verified_at = ?1, updated_at = ?1 WHERE provider_repo_id = ?2 AND status = 'degraded'",
                        vec![now.into(), repo_id.into()],
                    )?;
                    record_event(
                        sql,
                        "repository.ready_again",
                        SYSTEM,
                        None,
                        &Transition::NONE,
                        store::room_admins(sql)?,
                        now,
                    )?;
                    json!({ "status": LinkStatus::Ready.name(), "reason": Value::Null })
                }
            };
            store_answer(sql, &operator, &key, &hash, &answer, now)?;
            Ok(answer)
        })
    }

    /// The merge job, run by the room's alarm: one pass at each merge that's due, a couple an alarm.
    pub(super) async fn merge_upkeep(&self) -> R<()> {
        let sql = self.state.storage().sql();
        if !provisioning::enabled(&self.env, &sql)? {
            return Ok(());
        }
        let due: Vec<String> = rows(
            &sql,
            "SELECT task_id FROM task_change WHERE merge_state IN ('requested', 'outcome_unknown') AND merge_next_at <= ? ORDER BY merge_next_at LIMIT ?",
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

    /// Whether whoever gave `requester` their `merge` grant still holds the authority they gave it under, from that
    /// person's `Principal`. `None` if it can't say. The giver is read from the same rows the decision reads.
    pub(super) async fn merge_giver(
        &self,
        requester: &str,
        task_id: &str,
    ) -> Option<repositories::GiverRead> {
        let sql = self.state.storage().sql();
        let giver = read_inputs(&sql, requester, task_id, now_ms())
            .ok()?
            .and_then(|inputs| inputs.grant)
            .map(|grant| grant.delegated_by);
        self.giver_read(giver.as_deref()).await
    }

    /// What a pass asks before each of its transactions: [`Workspace::merge_giver`] for whoever asked for the task's
    /// merge, and whether the person who controls them still holds. `None` if either can't say.
    async fn requester_reads(&self, task_id: &str) -> Option<JobReads> {
        let sql = self.state.storage().sql();
        let asked = rows(
            &sql,
            "SELECT merge_requested_by, merge_requester_person, merge_requested_at FROM task_change WHERE task_id = ?",
            vec![task_id.into()],
        )
        .ok()?;
        let row = asked.first();
        let requester = row
            .and_then(|row| text(&row["merge_requested_by"]))
            .unwrap_or_default();
        let person = row.and_then(|row| text(&row["merge_requester_person"]));
        let since = row.and_then(|row| row["merge_requested_at"].as_i64());
        let giver = self.merge_giver(&requester, task_id).await?;
        // The organization the requester is in the room through: the room's own for its owner, and their member row's
        // otherwise. With no person or organization on record, nobody holds.
        let org = if is_owner(&sql, &requester).ok()? {
            room_owner_org(&sql).ok()
        } else {
            rows(
                &sql,
                "SELECT org_id FROM member WHERE principal_id = ?",
                vec![requester.as_str().into()],
            )
            .ok()?
            .first()
            .and_then(|member| text(&member["org_id"]))
        };
        let holds = match (&person, org, since) {
            (Some(person), Some(org), Some(since)) => {
                !principal::departed_since(&self.env, person, &org, since)
                    .await
                    .ok()?
            }
            _ => false,
        };
        Some(JobReads {
            giver,
            controller: ControllerRead {
                requester,
                person,
                holds,
            },
        })
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

    /// Ends a merge with `failure`. If a merge call is on record, GitHub is read first, and a merge that call made is
    /// recorded as this request's success: it was authorized when it was made.
    async fn end(
        &self,
        room: &str,
        task_id: &str,
        target: &Target,
        called: bool,
        failure: MergeFailure,
    ) -> R<()> {
        if called {
            return self
                .observe_then_end(room, task_id, target, failure.into())
                .await;
        }
        let (room, task) = (room.to_string(), task_id.to_string());
        self.in_transaction(move |sql| finish_failed(sql, &room, &task, failure, now_ms()))
    }

    /// For a merge whose call is on record and which is about to end as failed: reads the pull request and the default
    /// branch, and records what GitHub shows. Merged, with the reviewed commit as its head and the default branch
    /// holding it, is success. Anything else is `failure`. If GitHub can't be read, nothing is recorded yet, and the
    /// next pass tries again.
    async fn observe_then_end(
        &self,
        room: &str,
        task_id: &str,
        target: &Target,
        failure: Ending,
    ) -> R<()> {
        let sql = self.state.storage().sql();
        // GitHub can't be read: the outcome isn't known. That's recorded as such, never as a failure, and the job goes
        // on reading until it is known.
        let unknown = |pending: Ending| -> R<()> {
            let (room, task) = (room.to_string(), task_id.to_string());
            self.in_transaction(move |sql| finish_unknown(sql, &room, &task, &pending, now_ms()))
        };
        let Some(config) = self.merge_config(&sql) else {
            self.log_waiting(room, task_id, "configuration", 0);
            return unknown(failure);
        };
        let read = MergeApp::new(config)
            .observe(
                target.repo_id,
                target.number,
                &target.commit,
                &target.default_branch,
            )
            .await;
        self.log_unrevoked(&read, room, task_id);
        let seen = match read.answer {
            Ok(seen) => seen,
            Err(read_failure) => {
                self.log_waiting(room, task_id, "read", read_failure.status());
                return unknown(failure);
            }
        };
        let recorded = MergeAuthorized::when_called(task_id, target.repo_id, &target.commit);
        let reviewed = ReviewedBase {
            default_branch: &target.default_branch,
            base_sha: target.reviewed_base_sha.as_deref(),
        };
        // The same decision the pass that made the call would take, from core, so the two can't drift.
        let landed = match seen.pull {
            PullAnswer::Found(pull)
                if pull.number == target.number && pull.repo_id == Some(target.repo_id) =>
            {
                let decided = decide_landed(
                    &recorded,
                    &reviewed,
                    &observation(&pull, seen.default_branch_has),
                    None,
                    seen.default_branch.as_deref(),
                );
                Some((decided, pull))
            }
            _ => None,
        };
        let (room_id, task, repo_id) = (room.to_string(), task_id.to_string(), target.repo_id);
        match landed {
            Some((
                Landed::Merged {
                    proof,
                    default_branch_differs,
                },
                pull,
            )) => self.in_transaction(move |sql| {
                let now = now_ms();
                if default_branch_differs {
                    degrade(sql, repo_id, DEFAULT_BRANCH_CHANGED, now)?;
                }
                finish_succeeded(sql, &room_id, &task, proof, &pull, now)
            }),
            // Merged, and the default branch couldn't be read: that's GitHub not read, so the outcome isn't known yet.
            Some((Landed::DefaultBranchUnread, _)) => {
                self.log_waiting(room, task_id, "default_branch", 0);
                unknown(failure)
            }
            _ => {
                self.in_transaction(move |sql| fail_with(sql, &room_id, &task, &failure, now_ms()))
            }
        }
    }

    /// A pass at a merge whose outcome isn't known: it only reads, and the read settles it.
    async fn observe_unknown(&self, room: &str, task_id: &str) -> R<()> {
        let sql = self.state.storage().sql();
        let pending = rows(
            &sql,
            "SELECT merge_reason, commit_changed_at FROM task_change WHERE task_id = ? AND merge_state = 'outcome_unknown'",
            vec![task_id.into()],
        )?;
        let (Some(row), Some(target)) = (pending.first(), target(&sql, task_id)?) else {
            return Ok(());
        };
        // A room that's archived or suspended asks GitHub nothing more, reads included.
        if !room_open(&sql)? {
            let (room, task) = (room.to_string(), task_id.to_string());
            return self.in_transaction(move |sql| end_unknown_reads(sql, &room, &task, now_ms()));
        }
        let ending = Ending {
            code: text(&row["merge_reason"]).unwrap_or_else(|| "merge_outcome_unknown".to_string()),
            follow_up: false,
        };
        self.observe_then_end(room, task_id, &target, ending).await
    }

    /// One pass at one merge. Every way out leaves the merge either ended or due another pass, already counted.
    async fn merge_pass(&self, room: &str, task_id: &str) -> R<()> {
        // The standing of the grant's giver is asked of their `Principal` first: a grant counts only while its giver is
        // still the room's owner or an admin. If it can't say, the pass is counted and waits.
        let state = self.state.storage().sql();
        if merge_state_of(&state, task_id)? == Some(MergeState::OutcomeUnknown) {
            return self.observe_unknown(room, task_id).await;
        }
        let reads = self.requester_reads(task_id).await;
        let begun = self.in_transaction({
            let (room, task) = (room.to_string(), task_id.to_string());
            move |sql| begin(sql, &room, &task, reads, now_ms())
        })?;
        let pass = match begun {
            Begun::Nothing => return Ok(()),
            Begun::Wait => {
                self.log_waiting(room, task_id, "standing", 0);
                return Ok(());
            }
            Begun::Observe(target, ending) => {
                return self.observe_then_end(room, task_id, &target, ending).await
            }
            Begun::Go(pass) => pass,
        };
        let target = &pass.target;
        let sql = self.state.storage().sql();
        let Some(merge_config) = self.merge_config(&sql) else {
            self.log_waiting(room, task_id, "configuration", 0);
            return Ok(());
        };
        let merger = MergeApp::new(merge_config);
        match self
            .readiness(target.repo_id, target.public, &target.default_branch, room)
            .await
        {
            Readiness::Ready => {}
            Readiness::CouldNotRead(status) => {
                self.log_waiting(room, task_id, "readiness", status);
                return Ok(());
            }
            Readiness::Mismatch(code) => {
                // Nothing is marked or merged in a repository whose rules aren't the ones Podster set, and coding
                // work in the room stops until an operator has looked and rechecked it.
                let repo_id = target.repo_id;
                self.in_transaction(move |sql| degrade(sql, repo_id, code, now_ms()))?;
                let failure = if code == DEFAULT_BRANCH_CHANGED {
                    MergeFailure::DefaultBranchChanged
                } else {
                    MergeFailure::NotReady
                };
                return self.end(room, task_id, target, pass.called, failure).await;
            }
        }
        // The pull request and the default branch, as they are now.
        let read = merger
            .observe(
                target.repo_id,
                target.number,
                pass.authorized.commit_sha(),
                &target.default_branch,
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
        let Some(base_seen) = self.judge(room, task_id, &pass, seen, None).await? else {
            return Ok(());
        };
        // Mark: authority again and the intent, in one transaction; then the status on exactly the reviewed commit;
        // then that it was set.
        // The giver's standing is asked again, not carried from the start of the pass: a grant counts only while its
        // giver holds their authority now. If it can't be read, nothing more is asked of GitHub in this pass.
        let Some(reads) = self.requester_reads(task_id).await else {
            self.log_waiting(room, task_id, "standing", 0);
            return Ok(());
        };
        let intent = self.in_transaction({
            let (task, pass, base) = (
                task_id.to_string(),
                pass.clone_for_intent(),
                base_seen.clone(),
            );
            move |sql| {
                intend(
                    sql,
                    &task,
                    &pass,
                    &reads,
                    "mark",
                    "merge_marked_at = ?2",
                    &base,
                    now_ms(),
                )
            }
        })?;
        match intent {
            Intent::Go => {}
            Intent::Gone => return Ok(()),
            Intent::Wait => {
                self.log_waiting(room, task_id, "standing", 0);
                return Ok(());
            }
            Intent::Lost(failure) => {
                return self.end(room, task_id, target, pass.called, failure).await
            }
        }
        if dies(&sql, "before_mark") {
            return Ok(());
        }
        let mark = merger
            .mark(target.repo_id, pass.authorized.commit_sha())
            .await;
        self.log_unrevoked(&mark, room, task_id);
        if let Err(failure) = mark.answer {
            self.log_waiting(room, task_id, "mark", failure.status());
            return Ok(());
        }
        self.in_transaction({
            let task = task_id.to_string();
            move |sql| {
                exec(
                    sql,
                    "UPDATE task_change SET merge_step = 'marked', merge_mark_set_at = ? WHERE task_id = ? AND merge_state = 'requested'",
                    vec![now_ms().into(), task.as_str().into()],
                )
            }
        })?;
        if dies(&sql, "after_mark") {
            return Ok(());
        }
        // Merge: authority again, the intent and the base seen, in one transaction; then the call; then what GitHub shows.
        // The giver's standing is asked again, not carried from the start of the pass: a grant counts only while its
        // giver holds their authority now. If it can't be read, nothing more is asked of GitHub in this pass.
        let Some(reads) = self.requester_reads(task_id).await else {
            self.log_waiting(room, task_id, "standing", 0);
            return Ok(());
        };
        let intent = self.in_transaction({
            let (task, pass, base) = (task_id.to_string(), pass.clone_for_intent(), base_seen);
            move |sql| {
                intend(
                    sql,
                    &task,
                    &pass,
                    &reads,
                    "merge",
                    "merge_called_at = ?2, merge_base_sha = ?4",
                    &base,
                    now_ms(),
                )
            }
        })?;
        match intent {
            Intent::Go => {}
            Intent::Gone => return Ok(()),
            Intent::Wait => {
                self.log_waiting(room, task_id, "standing", 0);
                return Ok(());
            }
            Intent::Lost(failure) => {
                return self.end(room, task_id, target, pass.called, failure).await
            }
        }
        if dies(&sql, "before_merge_call") {
            return Ok(());
        }
        let merged = merger
            .merge(
                target.repo_id,
                target.number,
                pass.authorized.commit_sha(),
                &target.default_branch,
            )
            .await;
        self.log_unrevoked(&merged, room, task_id);
        if merged.failed_at_mint {
            // No token, so nothing was asked. If no call was on record before this pass, this one's is taken off
            // again, so a merge seen later isn't taken for it. An earlier pass's call stays on record.
            if !pass.called {
                let task = task_id.to_string();
                self.in_transaction(move |sql| {
                    exec(
                        sql,
                        "UPDATE task_change SET merge_called_at = NULL, merge_step = 'marked' WHERE task_id = ? AND merge_state = 'requested'",
                        vec![task.as_str().into()],
                    )
                })?;
            }
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
        // Every ending here follows a read of GitHub made a moment ago, so it's recorded as read.
        let finish = |failure: MergeFailure| -> R<Option<String>> {
            let (room, task) = (room.to_string(), task_id.to_string());
            self.in_transaction(move |sql| finish_failed(sql, &room, &task, failure, now_ms()))?;
            Ok(None)
        };
        let target = &pass.target;
        let pull = match seen.pull {
            PullAnswer::Found(pull)
                if pull.number == target.number && pull.repo_id == Some(target.repo_id) =>
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
        let reviewed = ReviewedBase {
            default_branch: &target.default_branch,
            base_sha: target.reviewed_base_sha.as_deref(),
        };
        // Once a merge call is on record, what became of it comes first, by the one decision core has for it. A merge
        // that landed is recorded as merged even if the default branch was changed between the check before the call and
        // this read, and then the link is degraded, so nothing more is merged until an operator has looked. Without the
        // default branch read, nothing is recorded, and the next pass reads again.
        if pass.called || call.is_some() {
            let landed = decide_landed(
                &pass.authorized,
                &reviewed,
                &observation(&pull, seen.default_branch_has),
                call.map(merge_call),
                seen.default_branch.as_deref(),
            );
            match landed {
                Landed::Merged {
                    proof,
                    default_branch_differs,
                } => {
                    let (room, task, repo_id) =
                        (room.to_string(), task_id.to_string(), target.repo_id);
                    self.in_transaction(move |sql| {
                        let now = now_ms();
                        if default_branch_differs {
                            degrade(sql, repo_id, DEFAULT_BRANCH_CHANGED, now)?;
                        }
                        finish_succeeded(sql, &room, &task, proof, &pull, now)
                    })?;
                    return Ok(None);
                }
                Landed::DefaultBranchUnread => {
                    self.log_waiting(room, task_id, "default_branch", 0);
                    return Ok(None);
                }
                Landed::No(_) => {}
            }
        }
        // The default branch GitHub reports, read with the pull request, must be the one the link holds: before the mark,
        // and again in the read that follows the merge call. A different one is a definite answer: the link is degraded
        // and nothing is merged into either branch. One that couldn't be read settles nothing.
        match seen.default_branch.as_deref() {
            Some(reported) if reported == target.default_branch => {}
            Some(_) => {
                let repo_id = target.repo_id;
                self.in_transaction(move |sql| {
                    degrade(sql, repo_id, DEFAULT_BRANCH_CHANGED, now_ms())
                })?;
                return finish(MergeFailure::DefaultBranchChanged);
            }
            None => {
                self.log_waiting(room, task_id, "default_branch", 0);
                return Ok(None);
            }
        }
        // Merged before this job ever asked GitHub for a merge: someone else's, whatever commit it was of.
        if pull.state == PullState::Merged && !pass.called && call.is_none() {
            return finish(MergeFailure::MergedElsewhere);
        }
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
            // A draft can't be merged.
            MergeStep::MarkAndMerge { .. } if pull.draft => finish(MergeFailure::PullDraft),
            MergeStep::MarkAndMerge { .. } => Ok(Some(pull.base_sha)),
        }
    }
}

impl Pass {
    /// A copy for a transaction's closure.
    fn clone_for_intent(&self) -> Pass {
        Pass {
            authorized: self.authorized.clone(),
            target: self.target.clone(),
            called: self.called,
        }
    }
}

/// Settles a merge whose outcome isn't known, from the ordinary watch's read of the pull request (M5 step 7a's
/// refresh), in the watch's own transaction with its observation. For any change in `outcome_unknown`, whether the job
/// is still reading for it or has stopped: the watch may well see the merge first, and it stops watching a merged pull
/// request, so it settles what it sees. `core::settle_unknown_from_watch` decides: merged with the reviewed commit into
/// the default branch is this request's success; closed unmerged, or merged at another commit, is its failure, with
/// the reason it was about to end with. A default branch that isn't the link's degrades the link and settles nothing.
/// Nothing more is read and no call is made for it, and the job's next read finds it settled and does nothing.
pub(super) fn settle_from_watch(
    sql: &SqlStorage,
    room: &str,
    task_id: &str,
    pull: &PullSeen,
    now: i64,
) -> R<()> {
    let held = rows(
        sql,
        "SELECT merge_reason FROM task_change WHERE task_id = ? AND merge_state = 'outcome_unknown'",
        vec![task_id.into()],
    )?;
    let (Some(row), Some(target)) = (held.first(), target(sql, task_id)?) else {
        return Ok(());
    };
    let recorded = MergeAuthorized::when_called(task_id, target.repo_id, &target.commit);
    let reviewed = ReviewedBase {
        default_branch: &target.default_branch,
        base_sha: target.reviewed_base_sha.as_deref(),
    };
    match settle_unknown_from_watch(
        &recorded,
        &reviewed,
        &observation(pull, None),
        pull.repo_default_branch.as_deref(),
    ) {
        WatchSettles::Merged(proof) => finish_succeeded(sql, room, task_id, proof, pull, now),
        WatchSettles::Failed => {
            let ending = Ending {
                code: text(&row["merge_reason"])
                    .unwrap_or_else(|| "merge_outcome_unknown".to_string()),
                follow_up: false,
            };
            fail_with(sql, room, task_id, &ending, now)
        }
        WatchSettles::DefaultBranchDiffers => {
            degrade(sql, target.repo_id, DEFAULT_BRANCH_CHANGED, now)
        }
        WatchSettles::NotYet => Ok(()),
    }
}
