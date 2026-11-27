//! A task's pull request: linking it at submission, pinning the commit at review, and recording what Podster's own
//! reads of GitHub show (M5 step 7a, ADR 0009, which is proposed). Nothing here merges anything: that's step 7b.
//!
//! Everything sits behind `MANAGED_REPOSITORIES`. With it off, a submission and an approval are exactly what they were.
//!
//! - **Which tasks.** A task made while the switch is on and the room's repository is ready is a linked task, for its
//!   whole life ([`links_new_tasks`]). One made earlier is linked once the repository is ready, while its work is still
//!   to do ([`link_open_tasks`], the owner's ruling of 2026-11-22): in the transaction that makes the link ready, once
//!   by the room after it starts, and when a reviewer sends it back. Nothing unlinks a task. A task with no linked
//!   repository is never asked for a pull request or blocked by the repository's state (M5-15).
//! - **A command's read comes before its transaction** ([`Workspace::read_for_command`]). The room first checks, on
//!   what it holds, that the caller could make the command at all, so someone who'd be refused anyway costs no call to
//!   GitHub. The transaction then decides again from current state, and takes what was read only as an observation:
//!   [`before_decide`] checks it against the room's link and hands the head to `core::decide`, and [`record`] writes
//!   the task's `task_change` beside the submission or the approval, in that same transaction.
//! - **The refresh job** ([`Workspace::refresh_changes`]) re-reads a change that's stale by step 5's decision, within
//!   the read cap, and records the observation as a command of its own: state, an event of IDs and states, and outbox
//!   rows, in one transaction. A read that fails waits longer each time, and a refusal of Podster itself makes the
//!   whole room's reads wait.
//! - **What's kept** is IDs, commit IDs, a state, a draft flag and times. A pull request's title, body, head branch
//!   name, labels and author never leave `crate::github`, and a base branch is kept only when it's the repository's
//!   default branch, which the room already holds. Logs carry the room's and the task's IDs and a status.
use super::*;
use crate::github::{
    AgentConfig, AgentTokens, ChecksReader, ChecksSeen, Failure, PullAnswer, PullRead, PullReader,
};
use podster_core::provider_deliveries::{poll_wait_ms, read_allowed, stale, ChangeWatch, Stale};
use podster_core::rate_limit::limit_repeated_after_reset;
use podster_core::release_status::{
    release_report, release_waiting, report, summarize_checks, AttemptHeld, CheckSeen,
    ChecksReport, HostHeld, JobHeld, ReleaseReport, ReleaseWaiting, StopSeen,
};
use podster_core::repo_merge::{ObservedMerge, PullState};
use podster_core::repositories::{
    links_existing_task, task_block, LinkStatus, MergeState, RequestState,
};
use podster_core::task_change::{
    check_pull, check_pull_number, classify_read_failure, observe, pull_state_from_name,
    pull_state_name, read_retry_wait_ms, stops_watching, targets_default, watched, Held,
    LinkRefusal, Linked, PullSeen, ReadFailure, ReadStage, CREDENTIAL_FAILED,
};

const HOUR_MS: i64 = 60 * 60 * 1000;
/// How many changes one alarm reads again. The rest wait for the next alarm, which is set for at once.
const MAX_REFRESHES_PER_ALARM: usize = 5;
/// Reads made for submissions and approvals, for one room's repository, in an hour. Counted apart from the refresh
/// job's, so neither can use up the other's. Proposed.
const MAX_COMMAND_READS_PER_HOUR: i64 = 60;
/// And for any one caller, so an assignee sending wrong commits can't use up the reviewer's. Proposed.
const MAX_COMMAND_READS_PER_CALLER_HOUR: i64 = 20;
/// Who a recorded observation is from: nobody in the room.
const SYSTEM: &str = "system";

fn refuse(status: u16, code: &'static str) -> ApiError {
    ApiError::api(status, code)
}

fn refused(refusal: LinkRefusal) -> ApiError {
    match refusal {
        LinkRefusal::NotFound => refuse(404, refusal.code()),
        _ => refuse(409, refusal.code()),
    }
}

/// The room's linked repository, from its own row.
struct Link {
    repo_id: i64,
    default_branch: String,
    status: Option<LinkStatus>,
    /// How many times in a row GitHub has refused Podster itself, and until when the room's reads wait because of it.
    read_failures: i64,
    reads_not_before: Option<i64>,
}

fn link(sql: &SqlStorage) -> R<Option<Link>> {
    Ok(rows(
        sql,
        "SELECT provider_repo_id, default_branch, status, read_failures, reads_not_before FROM repo_link WHERE provider = 'github'",
        vec![],
    )?
    .first()
    .map(|row| Link {
        repo_id: int(&row["provider_repo_id"]),
        default_branch: text(&row["default_branch"]).unwrap_or_default(),
        status: row["status"].as_str().and_then(LinkStatus::from_name),
        read_failures: int(&row["read_failures"]),
        reads_not_before: row["reads_not_before"].as_i64(),
    }))
}

fn request_state(sql: &SqlStorage) -> R<Option<RequestState>> {
    Ok(rows(sql, "SELECT state FROM repo_request", vec![])?
        .first()
        .and_then(|row| row["state"].as_str().and_then(RequestState::from_name)))
}

/// Whether a task made now is a linked task: managed repositories are on, and the room's repository is ready.
pub(super) fn links_new_tasks(sql: &SqlStorage, switched_on: bool) -> R<bool> {
    Ok(switched_on && link(sql)?.is_some_and(|link| link.status == Some(LinkStatus::Ready)))
}

/// Test builds only: whether the room holds a table of this name.
#[cfg(feature = "failpoints")]
fn has_table(sql: &SqlStorage, name: &str) -> bool {
    rows(
        sql,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        vec![name.into()],
    )
    .is_ok_and(|found| !found.is_empty())
}

/// The event a task gets when it's linked after it was made: its ID, and nothing else.
pub(super) const LINKED_LATER: &str = "task_change.repository_linked";

/// The room's link status, while managed repositories are on. Off, no task is linked, as none is made linked.
fn ready_link(sql: &SqlStorage, switched_on: bool) -> R<Option<LinkStatus>> {
    Ok(if switched_on {
        link(sql)?.and_then(|link| link.status)
    } else {
        None
    })
}

/// Links one task, in the caller's transaction: its flag, and one event naming it, from nobody in the room. No version
/// moves, so a command its assignee or reviewer already sent isn't refused for it.
fn link_task(sql: &SqlStorage, task_id: &str, now: i64) -> R<()> {
    exec(
        sql,
        "UPDATE task SET has_linked_repository = 1 WHERE id = ? AND has_linked_repository = 0",
        vec![task_id.into()],
    )?;
    record_event(
        sql,
        LINKED_LATER,
        SYSTEM,
        Some(task_id),
        &Transition::NONE,
        Vec::<String>::new(),
        now,
    )
}

/// Links every task the room holds that `core` says is due ([`links_existing_task`]): not linked yet, with its work still
/// to do, while managed repositories are on and the room's repository is ready. Run in the transaction that makes the
/// link ready, and once by the room after it starts ([`Workspace::link_open_tasks_once`]). Answers the IDs it linked, and
/// nothing a second time, since a linked task is never due again.
pub(super) fn link_open_tasks(sql: &SqlStorage, switched_on: bool, now: i64) -> R<Vec<String>> {
    let status = ready_link(sql, switched_on)?;
    if status != Some(LinkStatus::Ready) {
        return Ok(vec![]);
    }
    // Test builds only: a room holding this table fails after linking its first task, so a test sees it all rolled back.
    #[cfg(feature = "failpoints")]
    let fails = has_table(sql, "test_fail_link_open_tasks");
    let mut linked = Vec::new();
    for row in rows(
        sql,
        "SELECT id, status FROM task WHERE has_linked_repository = 0 ORDER BY created_at, id",
        vec![],
    )? {
        let due = row["status"]
            .as_str()
            .and_then(TaskStatus::from_name)
            .is_some_and(|task_status| links_existing_task(task_status, false, status));
        if let (true, Some(id)) = (due, text(&row["id"])) {
            link_task(sql, &id, now)?;
            linked.push(id);
            #[cfg(feature = "failpoints")]
            if fails {
                return Err(ApiError::internal("forced link failure"));
            }
        }
    }
    Ok(linked)
}

/// The same for one task a reviewer just sent back, in that command's transaction: it wasn't linked while it was in
/// review, and its work is to do again. Answers whether it was.
pub(super) fn link_if_due(sql: &SqlStorage, switched_on: bool, task: &Task, now: i64) -> R<bool> {
    if task.has_linked_repository
        || !links_existing_task(task.status, false, ready_link(sql, switched_on)?)
    {
        return Ok(false);
    }
    link_task(sql, &task.id, now)?;
    Ok(true)
}

impl Workspace {
    /// Links the room's due tasks once after the room starts, before its first request, so a room whose repository was
    /// ready before tasks were linked this way gets its open tasks linked without anyone asking (the owner's ruling of
    /// 2026-11-22). It's a pass of the room's own, like the refresh job, so it has no caller and no idempotency record:
    /// it's idempotent by its state, since a linked task is never due again. A room that isn't made or still has to
    /// migrate is left for its next request, and one that fails is tried again on it. Logs carry IDs and a count.
    pub(super) fn link_open_tasks_once(&self) {
        // Test builds only: a room holding this table is taken as started afresh, once, and the table goes.
        #[cfg(feature = "failpoints")]
        {
            let sql = self.state.storage().sql();
            if has_table(&sql, "test_room_restart") {
                let _ = exec(&sql, "DROP TABLE test_room_restart", vec![]);
                self.open_tasks_linked.set(false);
            }
        }
        if self.open_tasks_linked.get() {
            return;
        }
        let sql = self.state.storage().sql();
        let made = store::is_initialized(&sql).unwrap_or(false)
            && store::needs_migration(&sql).is_ok_and(|pending| !pending);
        if !made {
            return;
        }
        let switched_on = match provisioning::enabled(&self.env, &sql) {
            Ok(on) => on,
            Err(_) => return,
        };
        match self.in_transaction(move |sql| link_open_tasks(sql, switched_on, now_ms())) {
            Ok(linked) => {
                self.open_tasks_linked.set(true);
                if !linked.is_empty() {
                    let room = objects::room_id(&sql).unwrap_or_default();
                    console_log!(
                        "{}",
                        json!({ "at": "link_open_tasks", "room": room, "tasks": linked })
                    );
                }
            }
            Err(error) => {
                console_error!(
                    "{}",
                    json!({ "at": "link_open_tasks", "outcome": "failed", "code": error.code() })
                );
            }
        }
    }
}

fn change_row(sql: &SqlStorage, task_id: &str) -> R<Option<Value>> {
    Ok(rows(
        sql,
        "SELECT * FROM task_change WHERE task_id = ?",
        vec![task_id.into()],
    )?
    .into_iter()
    .next())
}

fn held_by_another(sql: &SqlStorage, repo_id: i64, number: i64, task_id: &str) -> R<bool> {
    Ok(!rows(
        sql,
        "SELECT 1 AS held FROM task_change WHERE provider_repo_id = ? AND pr_number = ? AND task_id <> ?",
        vec![repo_id.into(), number.into(), task_id.into()],
    )?
    .is_empty())
}

/// The pull request number a submission names. Anything but a positive whole number is no number at all.
fn named_number(body: &Value) -> R<i64> {
    body.get("pr_number")
        .and_then(Value::as_i64)
        .filter(|number| *number > 0)
        .ok_or_else(ApiError::invalid_argument)
}

/// The pull request an approval is of: the one on record for this submission, in the room's linked repository. A
/// submission made while the switch was off has none, and neither does a row for any other repository.
fn recorded_number(own: Option<&Value>, task: &Task, repo_id: i64) -> Option<i64> {
    own.filter(|row| {
        int(&row["submission_no"]) == i64::from(task.submission_no)
            && int(&row["provider_repo_id"]) == repo_id
    })
    .map(|row| int(&row["pr_number"]))
}

/// How a command's read came out.
enum Outcome {
    Seen(PullSeen),
    /// The repository has no pull request of that number.
    Missing,
    /// No read to go on, with the answer to give: the cap, a missing configuration, or GitHub not answering.
    Refused(u16, &'static str),
}

/// What a command read before its transaction: which pull request of which repository, and what came back.
pub(super) struct Fresh {
    repo_id: i64,
    number: i64,
    outcome: Outcome,
}

/// What a task command is run with. The default is managed repositories off and nothing read, which is every caller
/// but the task routes: with it, a linked task is decided exactly as before this step.
#[derive(Default)]
pub(super) struct Context {
    pub(super) switched_on: bool,
    pub(super) fresh: Option<Fresh>,
    /// The person who controls the caller, for a submission's record: see [`controller_of`].
    pub(super) controller: Option<String>,
}

/// The person who controls whoever sent a request: a person is their own, and an agent's is whoever linked the
/// credential it came with. `None` for an agent whose credential names no linker. From the gateway's assertion, never
/// from a body. Step 7b compares it between a submitter and whoever asks for the merge.
pub(super) fn controller_of(identity: &Identity) -> Option<String> {
    if identity.kind == "person" {
        Some(identity.id.clone())
    } else {
        identity.linker.as_ref().map(|linker| linker.person.clone())
    }
}

impl Context {
    /// Whether this command's decision depends on a read of the task's pull request.
    pub(super) fn reads_for(&self, task: &Task, verb: &str) -> bool {
        self.switched_on && task.has_linked_repository && matches!(verb, "submit" | "verify")
    }
}

/// What `before_decide` settled, for `record` once the decision is made.
pub(super) enum Pinned {
    /// The task needs its pull request read and nothing usable was. If the decision would otherwise go through, the
    /// command is refused and can be sent again.
    Unread,
    Read {
        repo_id: i64,
        number: i64,
        default_branch: String,
        pull: Box<PullSeen>,
        /// The person who controls the submitter, kept with the submission.
        controller: Option<String>,
    },
}

/// The agent-token App's configuration, or `None`. Test builds can stand for a deployment where it isn't set.
fn reader_config(env: &Env, sql: &SqlStorage) -> Option<AgentConfig> {
    #[cfg(feature = "failpoints")]
    if rows(
        sql,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_no_agent_app'",
        vec![],
    )
    .is_ok_and(|found| !found.is_empty())
    {
        return None;
    }
    #[cfg(not(feature = "failpoints"))]
    let _ = sql;
    AgentConfig::from_env(env)
}

/// Whether the command, as the room stands, would get as far as needing a read, and of which pull request, with who
/// is asking. It only saves calls: any refusal here is left for the transaction to give, from current state, in its
/// usual order.
fn plan_read(
    sql: &SqlStorage,
    identity: &Identity,
    task_id: &str,
    verb: &str,
    body: &Value,
) -> R<Option<(String, i64, i64)>> {
    let who = resolve_caller(sql, identity)?;
    let Some(task) = load_task(sql, task_id)? else {
        return Ok(None);
    };
    let action = if verb == "submit" {
        TaskAction::Submit
    } else {
        TaskAction::Verify
    };
    if !task.has_linked_repository || authorize_task(&who.caller, &task, action) != Verdict::Allow {
        return Ok(None);
    }
    if !podster_core::repositories::names_commit(&text(&body["commit_sha"])) {
        return Ok(None);
    }
    let Some(link) = link(sql)?.filter(|link| link.status == Some(LinkStatus::Ready)) else {
        return Ok(None);
    };
    let own = change_row(sql, task_id)?;
    let number = if verb == "submit" {
        let stands =
            task.status == TaskStatus::Accepted && body["version"].as_u64() == Some(task.version);
        let Some(number) = named_number(body).ok().filter(|_| stands) else {
            return Ok(None);
        };
        let own_number = own.as_ref().map(|row| int(&row["pr_number"]));
        let taken = held_by_another(sql, link.repo_id, number, task_id)?;
        if check_pull_number(own_number, number, taken).is_err() {
            return Ok(None);
        }
        number
    } else {
        let stands = task.status == TaskStatus::Submitted
            && body["submission_no"].as_u64() == Some(u64::from(task.submission_no))
            && task.assignee.as_deref() != Some(who.caller.id.as_str())
            && may_decide_review(who.caller.kind, store::requires_person_review(sql)?);
        match recorded_number(own.as_ref(), &task, link.repo_id).filter(|_| stands) {
            Some(number) => number,
            None => return Ok(None),
        }
    };
    Ok(Some((who.caller.id.clone(), link.repo_id, number)))
}

/// Counts one read against its hourly cap, if there's room. The refresh job's reads, with no caller, have the
/// repository's cap. A command's have the room's and the caller's own. Reads older than an hour are forgotten first.
fn count_read(sql: &SqlStorage, caller: Option<&str>, now: i64) -> R<bool> {
    exec(
        sql,
        "DELETE FROM repo_read WHERE at <= ?",
        vec![(now - HOUR_MS).into()],
    )?;
    let count = |filter: &str, bindings: Vec<V>| -> R<i64> {
        Ok(rows(
            sql,
            &format!("SELECT count(*) AS n FROM repo_read WHERE {filter}"),
            bindings,
        )?
        .first()
        .map_or(0, |row| int(&row["n"])))
    };
    let room = match caller {
        None => read_allowed(count("kind = 'job'", vec![])?.clamp(0, i64::from(u32::MAX)) as u32),
        Some(caller) => {
            count("kind = 'command'", vec![])? < MAX_COMMAND_READS_PER_HOUR
                && count("kind = 'command' AND caller = ?", vec![caller.into()])?
                    < MAX_COMMAND_READS_PER_CALLER_HOUR
        }
    };
    if room {
        let kind = if caller.is_some() { "command" } else { "job" };
        exec(
            sql,
            "INSERT INTO repo_read (at, kind, caller) VALUES (?, ?, ?)",
            vec![now.into(), kind.into(), caller.map_or(V::Null, V::from)],
        )?;
    }
    Ok(room)
}

/// The caller recorded on a scheduled read-back of the repository (`readiness_upkeep`), which counts against the
/// refresh job's hourly cap like any of its reads.
const READINESS_CALLER: &str = "readiness";

/// Counts one scheduled read-back against the repository's hourly read cap, if there's room.
pub(super) fn count_readiness_read(sql: &SqlStorage, now: i64) -> R<bool> {
    exec(
        sql,
        "DELETE FROM repo_read WHERE at <= ?",
        vec![(now - HOUR_MS).into()],
    )?;
    let made = rows(
        sql,
        "SELECT count(*) AS n FROM repo_read WHERE kind = 'job'",
        vec![],
    )?
    .first()
    .map_or(0, |row| int(&row["n"]));
    if !read_allowed(made.clamp(0, i64::from(u32::MAX)) as u32) {
        return Ok(false);
    }
    exec(
        sql,
        "INSERT INTO repo_read (at, kind, caller) VALUES (?, 'job', ?)",
        vec![now.into(), READINESS_CALLER.into()],
    )?;
    Ok(true)
}

/// When the repository's hourly read cap next has room, if it's full now: an hour after the oldest read it counts.
pub(super) fn read_cap_frees_at(sql: &SqlStorage, now: i64) -> R<Option<i64>> {
    let reads = rows(
        sql,
        "SELECT count(*) AS n, min(at) AS oldest FROM repo_read WHERE kind = 'job' AND at > ?",
        vec![(now - HOUR_MS).into()],
    )?;
    let (made, oldest) = reads
        .first()
        .map_or((0, None), |row| (int(&row["n"]), row["oldest"].as_i64()));
    Ok(oldest
        .filter(|_| !read_allowed(made.clamp(0, i64::from(u32::MAX)) as u32))
        .map(|oldest| oldest + HOUR_MS))
}

/// When the last scheduled read-back within the hour was made, if one was.
pub(super) fn last_readiness_read(sql: &SqlStorage, now: i64) -> R<Option<i64>> {
    Ok(rows(
        sql,
        "SELECT max(at) AS at FROM repo_read WHERE kind = 'job' AND caller = ? AND at > ?",
        vec![READINESS_CALLER.into(), (now - HOUR_MS).into()],
    )?
    .first()
    .and_then(|row| row["at"].as_i64()))
}

/// GitHub rate-limited a read: the refresh job's reads of this repository wait until `until`, or longer if they were
/// already waiting. Nothing else is recorded: a limit is no refusal of Podster (the M5 security review's F1).
fn hold_reads(sql: &SqlStorage, repo_id: i64, until: i64) -> R<()> {
    exec(
        sql,
        "UPDATE repo_link SET reads_not_before = max(COALESCE(reads_not_before, 0), ?) WHERE provider_repo_id = ?",
        vec![until.into(), repo_id.into()],
    )
}

/// A read's token that GitHub didn't confirm taking back lives out its hour: read-only, on the one repository. Said in
/// the log with IDs only.
fn note_unrevoked(read: &PullRead, room: &str, task: &str) {
    if !read.revoked {
        console_error!(
            "{}",
            json!({ "event": "task_change.token_unrevoked", "ws": room, "task": task })
        );
    }
}

impl Workspace {
    /// Reads the task's pull request for a submission or an approval, before the command's transaction. `None` when no
    /// read is called for: the switch is off, the task isn't linked, or the command would be refused on what the room
    /// holds. It decides nothing.
    pub(super) async fn read_for_command(
        &self,
        identity: &Identity,
        task_id: &str,
        verb: &str,
        body: &Value,
        switched_on: bool,
    ) -> Option<Fresh> {
        if !switched_on || !matches!(verb, "submit" | "verify") {
            return None;
        }
        let sql = self.state.storage().sql();
        let (caller, repo_id, number) = plan_read(&sql, identity, task_id, verb, body).ok()??;
        let fresh = |outcome| {
            Some(Fresh {
                repo_id,
                number,
                outcome,
            })
        };
        let now = now_ms();
        match self.in_transaction(move |sql| count_read(sql, Some(&caller), now)) {
            Ok(true) => {}
            Ok(false) => return fresh(Outcome::Refused(429, "rate_limited")),
            Err(_) => return None,
        }
        let Some(config) = reader_config(&self.env, &sql) else {
            return fresh(Outcome::Refused(503, "repo_access_unavailable"));
        };
        let read = AgentTokens::new(config).read_pull(repo_id, number).await;
        note_unrevoked(&read, &identity.workspace_id, task_id);
        fresh(match read.answer {
            Ok(PullAnswer::Found(pull)) => Outcome::Seen(pull),
            Ok(PullAnswer::Missing) => Outcome::Missing,
            Err(failure) => {
                console_error!(
                    "{}",
                    json!({ "event": "task_change.read_failed", "ws": identity.workspace_id, "task": task_id, "status": failure.status() })
                );
                // A limit holds the refresh job's reads too, so it doesn't spend the rest of the installation's hour.
                if let Some(wait) = failure.rate_limit_wait_ms() {
                    let until = now_ms() + wait;
                    let _ = self.in_transaction(move |sql| hold_reads(sql, repo_id, until));
                }
                Outcome::Refused(502, "provider_unavailable")
            }
        })
    }
}

/// Before `core::decide`, in the command's transaction: for a linked task with the switch on, checks the pull request
/// against the room's link and the task's record, and gives `decide` the head that was read. `None` for any other task
/// or command, which then goes on untouched. The caller has already run `decide` once without the read, so a command
/// that's stale or wrong in itself is answered as that, and never with anything about a pull request.
pub(super) fn before_decide(
    sql: &SqlStorage,
    context: Context,
    task: &Task,
    verb: &str,
    body: &Value,
    observed: &mut Observed,
) -> R<Option<Pinned>> {
    if !context.reads_for(task, verb) {
        return Ok(None);
    }
    let link = link(sql)?;
    let status = link.as_ref().and_then(|link| link.status);
    if task_block(true, request_state(sql)?, status).is_some() {
        return Err(refuse(409, "repo_not_ready"));
    }
    let link = link.ok_or_else(|| refuse(409, "repo_not_ready"))?;
    let own = change_row(sql, &task.id)?;
    let number = if verb == "submit" {
        let number = named_number(body)?;
        let own_number = own.as_ref().map(|row| int(&row["pr_number"]));
        let taken = held_by_another(sql, link.repo_id, number, &task.id)?;
        check_pull_number(own_number, number, taken).map_err(refused)?;
        number
    } else {
        recorded_number(own.as_ref(), task, link.repo_id)
            .ok_or_else(|| refuse(409, "change_not_found"))?
    };
    // Only a read of this pull request in this repository counts. Anything else is as good as none.
    let controller = context.controller;
    let Some(fresh) = context
        .fresh
        .filter(|fresh| fresh.repo_id == link.repo_id && fresh.number == number)
    else {
        return Ok(Some(Pinned::Unread));
    };
    let pull = match fresh.outcome {
        Outcome::Seen(pull) => pull,
        Outcome::Missing => return Err(refused(LinkRefusal::NotFound)),
        Outcome::Refused(status, code) => return Err(refuse(status, code)),
    };
    let linked = Linked {
        repo_id: link.repo_id,
        default_branch: &link.default_branch,
    };
    check_pull(&linked, number, &pull).map_err(refused)?;
    // `decide` refuses with `commit_changed` unless this is the commit the command names.
    observed.head_sha = Some(pull.head_sha.clone());
    Ok(Some(Pinned::Read {
        repo_id: link.repo_id,
        number,
        default_branch: link.default_branch,
        pull: Box::new(pull),
        controller,
    }))
}

/// After the decision, in the same transaction: writes the task's change. A submission records the pull request and
/// what was seen of it. An approval records the reviewed commit and the base it was reviewed on, from the read made for
/// that approval. Approving merges nothing (AC-17). Either was read open, not a draft and on the default branch, and a
/// read that worked ends any run of failed ones.
pub(super) fn record(
    sql: &SqlStorage,
    caller: &str,
    task: &Task,
    verb: &str,
    pinned: Pinned,
    now: i64,
) -> R<()> {
    let Pinned::Read {
        repo_id,
        number,
        default_branch,
        pull,
        controller,
    } = pinned
    else {
        return Err(refuse(409, "pull_request_unread"));
    };
    let state = pull_state_name(pull.state);
    if verb == "verify" {
        return exec(
            sql,
            "UPDATE task_change SET reviewed_commit_sha = ?1, reviewed_base_sha = ?2, observed_head_sha = ?1, head_observed_at = ?3, head_repo_id = ?4,
               base_ref = ?5, observed_base_sha = ?2, pr_state = ?6, pr_draft = 0, pr_observed_at = ?3, read_at = ?3, unchanged_reads = 0,
               read_failures = 0, not_found_reads = 0, unwatched_at = NULL, updated_at = ?3, reviewer_id = ?10, reviewer_person = ?11
             WHERE task_id = ?7 AND provider_repo_id = ?8 AND pr_number = ?9",
            vec![
                pull.head_sha.as_str().into(),
                pull.base_sha.as_str().into(),
                now.into(),
                pull.head_repo_id.map_or(V::Null, V::from),
                default_branch.as_str().into(),
                state.into(),
                task.id.as_str().into(),
                repo_id.into(),
                number.into(),
                // Who approved, and the person who controlled them then: what a merge's independent review compares
                // with the submitter's (the owner's decision of 2026-11-11 on review A1). From the room's caller and the
                // gateway's assertion, never from a body.
                caller.into(),
                controller.as_deref().map_or(V::Null, V::from),
            ],
        );
    }
    let first = change_row(sql, &task.id)?.is_none();
    exec(
        sql,
        "INSERT INTO task_change (task_id, provider_repo_id, pr_number, submission_no, observed_head_sha, head_observed_at, head_repo_id, base_ref,
             observed_base_sha, pr_state, pr_draft, pr_observed_at, read_at, created_at, updated_at, submitter_id, submitter_person)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 0, ?6, ?6, ?6, ?6, ?11, ?12)
           ON CONFLICT (task_id) DO UPDATE SET submission_no = excluded.submission_no, observed_head_sha = excluded.observed_head_sha,
             head_observed_at = excluded.head_observed_at, head_repo_id = excluded.head_repo_id, base_ref = excluded.base_ref,
             observed_base_sha = excluded.observed_base_sha, pr_state = excluded.pr_state, pr_draft = 0, pr_observed_at = excluded.pr_observed_at,
             read_at = excluded.read_at, unchanged_reads = 0, read_failures = 0, not_found_reads = 0, unwatched_at = NULL,
             reviewed_commit_sha = NULL, reviewed_base_sha = NULL, reviewer_id = NULL, reviewer_person = NULL, updated_at = excluded.updated_at,
             submitter_id = excluded.submitter_id, submitter_person = excluded.submitter_person,
             checks_state = CASE WHEN task_change.observed_head_sha IS excluded.observed_head_sha THEN checks_state ELSE NULL END,
             checks_json = CASE WHEN task_change.observed_head_sha IS excluded.observed_head_sha THEN checks_json ELSE NULL END,
             checks_observed_at = CASE WHEN task_change.observed_head_sha IS excluded.observed_head_sha THEN checks_observed_at ELSE NULL END",
        vec![
            task.id.as_str().into(),
            repo_id.into(),
            number.into(),
            i64::from(task.submission_no).into(),
            pull.head_sha.as_str().into(),
            now.into(),
            pull.head_repo_id.map_or(V::Null, V::from),
            default_branch.as_str().into(),
            pull.base_sha.as_str().into(),
            state.into(),
            // Who submitted, and the person who controlled them then: what a merge's submitter rule compares (step 7b).
            caller.into(),
            controller.as_deref().map_or(V::Null, V::from),
        ],
    )?;
    if first {
        // The submission's own event tells the reviewer. This one says only that the task now has a change.
        record_event(
            sql,
            "task_change.linked",
            caller,
            Some(&task.id),
            &Transition::NONE,
            Vec::<String>::new(),
            now,
        )?;
    }
    Ok(())
}

/// A task's change, for those `podster_policy::repositories::sees_task_change` allows: IDs, commit IDs, states and
/// times. `commit_changed` says the head has been seen off the reviewed commit, and stays true even if the branch is
/// put back: the approval stands, and the way on is a follow-up task (decision 25).
/// A task read with managed repositories switched off has no `change` at all, even for a task that got one while they
/// were on, and its history has none of the events about its pull request or its merge: off, the feature isn't there,
/// and its rows stay in the room for when it's back.
pub(super) fn without_change_when_off(mut read: Value, switched_on: bool) -> R<Value> {
    if !switched_on {
        if let Some(fields) = read.as_object_mut() {
            fields.remove("change");
            if let Some(history) = fields.get_mut("history").and_then(Value::as_array_mut) {
                history.retain(|event| {
                    podster_policy::shows_with_switch(
                        event["type"].as_str().unwrap_or_default(),
                        false,
                    )
                });
            }
        }
    }
    Ok(read)
}

/// A task's change as the task read shows it. `merge_self_reviewed` says the last merge request was a self-reviewed one,
/// from the change row's record of who asked, submitted and approved. `self_review_for_viewer` says whether a merge this
/// viewer asked for now would be a self-reviewed one, by the same pure rule the merge decides with, so the merge dialog
/// can say so; for a public room's owner, that is with the public acknowledgement, which
/// `public_acknowledgement_for_viewer` says the request needs (decision 186 as revised 2026-11-27). They show and never
/// authorize: `merge_task` decides again from the room's rows when asked.
pub(super) fn of_task(sql: &SqlStorage, task: &Task, viewer: &Caller) -> R<Value> {
    let task_id = task.id.as_str();
    let Some(row) = change_row(sql, task_id)? else {
        return Ok(Value::Null);
    };
    let merge_self_reviewed = super::merges::self_reviewed_request(&row);
    let reviewer = super::merges::reviewer_of(&row);
    let (submitter_id, submitter_person) = super::merges::submitter_of(Some(&row), task);
    let room_private = super::merges::room_is_private(sql)?;
    // As if the viewer acknowledged: whether they could, and then whether they'd need to.
    let review = super::merges::self_review_of(viewer, room_private, true, reviewer.as_ref());
    let self_review_for_viewer = viewer.kind == PrincipalKind::Person
        && podster_core::repo_merge::is_self_reviewed(
            &podster_core::repo_merge::Actor {
                id: &viewer.id,
                person: Some(&viewer.id),
            },
            &podster_core::repo_merge::Actor {
                id: &submitter_id,
                person: submitter_person.as_deref(),
            },
            &review,
        );
    // Display only, by the policy's own submitter rule: a merge this viewer asked for now would be refused `self_merge`.
    // `review` counts the public acknowledgement as given, so a public room's owner who may self-merge with it isn't.
    let viewer_merge_refusal = podster_policy::repositories::self_merge_hint(
        viewer,
        task,
        &podster_core::repo_merge::Actor {
            id: &submitter_id,
            person: submitter_person.as_deref(),
        },
        &review,
    )
    .map(podster_policy::repositories::SelfMergeHint::code);
    let public_acknowledgement_for_viewer = self_review_for_viewer && !room_private;
    let observed = row["pr_observed_at"].as_i64();
    let head_here = row["head_repo_id"]
        .as_i64()
        .is_some_and(|head| Some(head) == row["provider_repo_id"].as_i64());
    Ok(json!({
        "provider_repo_id": row["provider_repo_id"], "pr_number": row["pr_number"], "submission_no": row["submission_no"],
        "pr_state": row["pr_state"], "pr_draft": row["pr_draft"].as_i64().map(|draft| draft != 0), "pr_observed_at": row["pr_observed_at"],
        "observed_head_sha": row["observed_head_sha"], "head_observed_at": row["head_observed_at"],
        "head_in_repository": observed.map(|_| head_here),
        "base_is_default": observed.map(|_| row["base_ref"].is_string()),
        "observed_base_sha": row["observed_base_sha"],
        "reviewed_commit_sha": row["reviewed_commit_sha"], "reviewed_base_sha": row["reviewed_base_sha"],
        "commit_changed": row["commit_changed_at"].as_i64().is_some(), "commit_changed_at": row["commit_changed_at"],
        "watched": row["unwatched_at"].is_null(),
        "merge_state": row["merge_state"], "merge_reason": row["merge_reason"], "merge_sha": row["merge_sha"],
        "merge_observed_at": row["merge_observed_at"],
        "merge_requested_by": row["merge_requested_by"], "merge_requested_at": row["merge_requested_at"],
        "merge_finished_at": row["merge_finished_at"],
        "merge_self_reviewed": merge_self_reviewed, "self_review_for_viewer": self_review_for_viewer,
        "viewer_merge_refusal": viewer_merge_refusal,
        "public_acknowledgement_for_viewer": public_acknowledgement_for_viewer,
    }))
}

/// One change the refresh job might read.
struct Watch {
    task_id: String,
    repo_id: i64,
    number: i64,
    /// When it's next due a read. Now or earlier means it's stale.
    due: i64,
    nudged: bool,
}

/// Every change the job watches, with when each is due. Only for a ready repository: one that's degraded or suspended
/// isn't read. A change the job gave up on isn't either, until a delivery names it or a command reads it again.
fn watches(sql: &SqlStorage, now: i64) -> R<Vec<Watch>> {
    let found = rows(
        sql,
        "SELECT c.task_id, c.provider_repo_id, c.pr_number, c.pr_state, c.nudged_at, c.read_at, c.unchanged_reads, c.read_failures, t.status
           FROM task_change c JOIN task t ON t.id = c.task_id
           JOIN repo_link l ON l.provider_repo_id = c.provider_repo_id AND l.status = 'ready'
          WHERE t.status IN ('submitted', 'completed') AND (c.pr_state IS NULL OR c.pr_state <> 'merged') AND c.unwatched_at IS NULL",
        vec![],
    )?;
    let mut out = vec![];
    for row in &found {
        let read_at = row["read_at"].as_i64();
        let nudged_at = row["nudged_at"].as_i64();
        let nudged_since_read =
            nudged_at.is_some_and(|nudged| read_at.is_none_or(|read| nudged > read));
        let Some(status) = row["status"].as_str().and_then(TaskStatus::from_name) else {
            continue;
        };
        let state = row["pr_state"].as_str().and_then(pull_state_from_name);
        let unchanged_reads = int(&row["unchanged_reads"]).clamp(0, 64) as u32;
        let failures = int(&row["read_failures"]).clamp(0, 64) as u32;
        let watch = ChangeWatch {
            nudged_at,
            read_at,
            unchanged_reads,
            watched: watched(status, state, nudged_since_read),
        };
        if !watch.watched {
            continue;
        }
        let kind = stale(&watch, now);
        // After failed reads the change waits out its backoff, whatever a delivery says in the meantime.
        // Each due time is built from a stored time, the last read or the delivery, never from this call's clock plus a
        // wait, so the alarm set from it doesn't drift later with every pass.
        let due = if failures > 0 {
            read_at.unwrap_or(now) + read_retry_wait_ms(failures)
        } else if kind == Some(Stale::Nudged) {
            nudged_at.unwrap_or(now).min(now)
        } else {
            read_at.map_or(now, |read| read + poll_wait_ms(unchanged_reads))
        };
        out.push(Watch {
            task_id: text(&row["task_id"]).unwrap_or_default(),
            repo_id: int(&row["provider_repo_id"]),
            number: int(&row["pr_number"]),
            due,
            nudged: kind == Some(Stale::Nudged),
        });
    }
    // A change a delivery named goes before one that's only due its poll.
    out.sort_by_key(|watch| (!watch.nudged, watch.due));
    Ok(out)
}

/// When the refresh job next has something to read, for the room's alarm. `None` while it has nothing, or nothing it
/// could do: the switch off, or no App to read with. With the hour's reads used up, not before the oldest is an hour
/// old, and while GitHub is refusing Podster, not before the room's wait is over.
pub(super) fn next_due(sql: &SqlStorage, env: &Env, now: i64) -> R<Option<i64>> {
    if !provisioning::enabled(env, sql)? || reader_config(env, sql).is_none() {
        return Ok(None);
    }
    let Some(due) = watches(sql, now)?.iter().map(|watch| watch.due).min() else {
        return Ok(None);
    };
    let reads = rows(
        sql,
        "SELECT count(*) AS n, min(at) AS oldest FROM repo_read WHERE kind = 'job' AND at > ?",
        vec![(now - HOUR_MS).into()],
    )?;
    let (made, oldest) = reads
        .first()
        .map_or((0, None), |row| (int(&row["n"]), row["oldest"].as_i64()));
    let capped = !read_allowed(made.clamp(0, i64::from(u32::MAX)) as u32);
    let blocked = link(sql)?.and_then(|link| link.reads_not_before);
    let due = due.max(blocked.unwrap_or(0));
    Ok(Some(match oldest.filter(|_| capped) {
        Some(oldest) => due.max(oldest + HOUR_MS),
        None => due.max(now + 10),
    }))
}

/// Records what one read by the refresh job showed, in the caller's transaction. A command: state, events of IDs and
/// states, and outbox rows commit together. Answers whether GitHub refused Podster itself, which stops this alarm's
/// other reads.
fn apply_read(
    sql: &SqlStorage,
    room: &str,
    watch: &Watch,
    answer: std::result::Result<PullAnswer, Failure>,
    failed_at_mint: bool,
    now: i64,
) -> R<bool> {
    // The room may have changed while GitHub was answering. Only the same pull request of the same linked repository.
    let Some(row) = change_row(sql, &watch.task_id)?.filter(|row| {
        int(&row["provider_repo_id"]) == watch.repo_id && int(&row["pr_number"]) == watch.number
    }) else {
        return Ok(false);
    };
    let (Some(link), Some(task)) = (
        link(sql)?.filter(|link| link.repo_id == watch.repo_id),
        load_task(sql, &watch.task_id)?,
    ) else {
        return Ok(false);
    };
    let task_id = Some(watch.task_id.as_str());
    let reason = |reason: &'static str| Transition {
        reason: Some(reason),
        ..Transition::NONE
    };
    let log_failed = |status: u16| {
        console_error!(
            "{}",
            json!({ "event": "task_change.read_failed", "ws": room, "task": watch.task_id, "status": status })
        );
    };
    // A failed read waits longer each time, a minute doubling to an hour, and never resets the poll's own backoff.
    // `not_found` is the run of answers that the pull request isn't there, which only GitHub's own answer about the
    // pull request adds to. Any other failure ends that run.
    let waits = |not_found: i64| -> R<bool> {
        let gone = stops_watching(not_found.clamp(0, 64) as u32);
        exec(
            sql,
            "UPDATE task_change SET read_at = ?1, read_failures = min(read_failures + 1, 64), not_found_reads = ?2,
               unwatched_at = CASE WHEN ?3 THEN ?1 ELSE unwatched_at END WHERE task_id = ?4",
            vec![
                now.into(),
                not_found.into(),
                flag(gone),
                watch.task_id.as_str().into(),
            ],
        )?;
        if gone {
            // The pull request isn't there any more, so the job stops asking until a delivery names it again or a
            // command reads it. The room's owner and admins are told.
            record_event(
                sql,
                "task_change.unwatched",
                SYSTEM,
                task_id,
                &reason(LinkRefusal::NotFound.code()),
                store::room_admins(sql)?,
                now,
            )?;
        }
        Ok(false)
    };
    let failed = |stage: ReadStage, status: u16, limit_wait: Option<i64>| -> R<bool> {
        log_failed(status);
        match classify_read_failure(stage, status, limit_wait.is_some()) {
            ReadFailure::Other => return waits(0),
            ReadFailure::RateLimited => {
                // GitHub limited the rate, for every read through this installation. The room's reads wait until the
                // time GitHub gave, and nothing else changes: no refusal is recorded, no change is touched, and the
                // run of refusals isn't added to. This alarm's other reads stop.
                hold_reads(sql, watch.repo_id, now + limit_wait.unwrap_or_default())?;
                return Ok(true);
            }
            ReadFailure::Credential => {}
        }
        // A key, a permission or the installation: every change in the room would fail the same way, so the room's
        // reads wait and no change is touched. Said once for each run of refusals, with a fixed code.
        let failures = link.read_failures.saturating_add(1).clamp(1, 64);
        exec(
            sql,
            "UPDATE repo_link SET read_failures = ?, reads_not_before = ? WHERE provider_repo_id = ?",
            vec![
                failures.into(),
                (now + read_retry_wait_ms(failures as u32)).into(),
                watch.repo_id.into(),
            ],
        )?;
        if failures == 1 {
            record_event(
                sql,
                "repository.read_refused",
                SYSTEM,
                None,
                &reason(CREDENTIAL_FAILED),
                store::room_admins(sql)?,
                now,
            )?;
        }
        Ok(true)
    };
    let stage = if failed_at_mint {
        ReadStage::Mint
    } else {
        ReadStage::Read
    };
    let seen = match answer {
        Ok(PullAnswer::Found(seen))
            if seen.number == watch.number && seen.repo_id == Some(watch.repo_id) =>
        {
            seen
        }
        Ok(PullAnswer::Found(_)) => return failed(ReadStage::Read, 0, None),
        Ok(PullAnswer::Missing) => {
            log_failed(404);
            return waits(int(&row["not_found_reads"]).saturating_add(1).clamp(1, 64));
        }
        Err(failure) => {
            // A spent-limit 403 again after the room's reads waited out the last limit (a limit leaves the run of
            // refusals at 0) is a refusal, not a limit.
            let held = link.reads_not_before.filter(|_| link.read_failures == 0);
            let again = limit_repeated_after_reset(failure.primary_403(), held, now);
            let wait = failure.rate_limit_wait_ms().filter(|_| !again);
            return failed(stage, failure.status(), wait);
        }
    };
    if link.read_failures > 0 || link.reads_not_before.is_some() {
        exec(
            sql,
            "UPDATE repo_link SET read_failures = 0, reads_not_before = NULL WHERE provider_repo_id = ?",
            vec![watch.repo_id.into()],
        )?;
    }
    let linked = Linked {
        repo_id: link.repo_id,
        default_branch: &link.default_branch,
    };
    let held = Held {
        head_sha: row["observed_head_sha"].as_str(),
        head_repo_id: row["head_repo_id"].as_i64(),
        base_is_default: row["pr_observed_at"]
            .as_i64()
            .map(|_| row["base_ref"].is_string()),
        state: row["pr_state"].as_str().and_then(pull_state_from_name),
        draft: row["pr_draft"].as_i64().map(|draft| draft != 0),
        reviewed_commit_sha: row["reviewed_commit_sha"].as_str(),
        commit_changed_recorded: row["commit_changed_at"].as_i64().is_some(),
        merge_state: row["merge_state"]
            .as_str()
            .and_then(MergeState::from_name)
            .unwrap_or(MergeState::NotRequested),
        merge_recorded: row["merge_observed_at"].as_i64().is_some(),
    };
    let observation = observe(&task, &linked, &held, &seen);
    let state = pull_state_name(seen.state);
    // A base branch is kept only when it's the default branch, which the room already holds. Any other name is the
    // pull request's own text, so what's kept is that it isn't the default.
    let base_ref = targets_default(&linked, &seen).then_some(link.default_branch.as_str());
    exec(
        sql,
        "UPDATE task_change SET observed_head_sha = ?1, head_observed_at = ?2, head_repo_id = ?3, base_ref = ?4, observed_base_sha = ?5, pr_state = ?6,
           pr_draft = ?7, pr_observed_at = ?2, read_at = ?2, unchanged_reads = CASE WHEN ?8 THEN 0 ELSE unchanged_reads + 1 END,
           read_failures = 0, not_found_reads = 0, updated_at = CASE WHEN ?8 THEN ?2 ELSE updated_at END
         WHERE task_id = ?9",
        vec![
            seen.head_sha.as_str().into(),
            now.into(),
            seen.head_repo_id.map_or(V::Null, V::from),
            base_ref.map_or(V::Null, V::from),
            seen.base_sha.as_str().into(),
            state.into(),
            flag(seen.draft),
            flag(observation.changed),
            watch.task_id.as_str().into(),
        ],
    )?;
    // A merge whose outcome the merge job stopped reading for is settled by this read, if it says enough.
    merges::settle_from_watch(sql, room, &watch.task_id, &seen, now)?;
    // Checks were read for one commit. Once the head is another, they aren't this head's, and aren't kept as if they were.
    if held.head_sha != Some(seen.head_sha.as_str()) {
        exec(
            sql,
            "UPDATE task_change SET checks_state = NULL, checks_json = NULL, checks_observed_at = NULL WHERE task_id = ?",
            vec![watch.task_id.as_str().into()],
        )?;
    }
    if observation.changed {
        // The state as people would say it: an open pull request marked as a draft is a draft.
        let said = if seen.state == PullState::Open && seen.draft {
            "draft"
        } else {
            state
        };
        record_event(
            sql,
            "task_change.observed",
            SYSTEM,
            task_id,
            &reason(said),
            Vec::<String>::new(),
            now,
        )?;
    }
    if observation.commit_changed {
        // Kept from now on, even if the branch is put back. The approval stands and the reviewed commit stays what it
        // was. The people who'd open the follow-up are told.
        exec(
            sql,
            "UPDATE task_change SET commit_changed_at = ?, updated_at = ? WHERE task_id = ? AND commit_changed_at IS NULL",
            vec![now.into(), now.into(), watch.task_id.as_str().into()],
        )?;
        let mut told = store::room_admins(sql)?;
        // The reviewer is always shown a task's change. The requester only if they're a person in the room and no guest,
        // as `sees_task_change` has it, so the notice reaches nobody the change itself is hidden from.
        if participant(sql, &task.reviewer)?.is_some() {
            told.push(task.reviewer.clone());
        }
        if participant(sql, &task.requester)?
            .is_some_and(|(kind, role)| kind == "person" && role != "guest")
        {
            told.push(task.requester.clone());
        }
        told.sort();
        told.dedup();
        record_event(
            sql,
            "task_change.commit_changed",
            SYSTEM,
            task_id,
            &reason("commit_changed"),
            told,
            now,
        )?;
    }
    // A merge Podster asked for is the merge job's own to record (step 7b), so nothing about it is written here and
    // `merge_observed_at` always means a merge Podster didn't ask for. That one is recorded with its reason, for the
    // room's owner and admins, and is never a success: `merge_state` isn't touched.
    let unasked = observation
        .merge
        .filter(|merge| *merge != ObservedMerge::Requested)
        .and_then(ObservedMerge::reason);
    if let Some(code) = unasked {
        exec(
            sql,
            "UPDATE task_change SET merge_sha = ?, merged_by_id = ?, merge_observed_at = ?, merge_reason = ?, updated_at = ? WHERE task_id = ?",
            vec![
                seen.merge_sha.as_deref().map_or(V::Null, V::from),
                seen.merged_by_id.map_or(V::Null, V::from),
                now.into(),
                code.into(),
                now.into(),
                watch.task_id.as_str().into(),
            ],
        )?;
        record_event(
            sql,
            "task_change.merge_observed",
            SYSTEM,
            task_id,
            &reason(code),
            store::room_admins(sql)?,
            now,
        )?;
    }
    Ok(false)
}

impl Workspace {
    /// The refresh job, run by the room's alarm: re-reads each change that's stale, a few at a time and within the
    /// hour's cap, and records what it saw. Does nothing while the switch is off, there's no App to read with, or the
    /// room is waiting because GitHub refused Podster.
    pub(super) async fn refresh_changes(&self) -> R<()> {
        let sql = self.state.storage().sql();
        if !provisioning::enabled(&self.env, &sql)? {
            return Ok(());
        }
        let now = now_ms();
        let waiting = link(&sql)?
            .and_then(|link| link.reads_not_before)
            .is_some_and(|until| until > now);
        if waiting {
            return Ok(());
        }
        let mut stale: Vec<Watch> = watches(&sql, now)?
            .into_iter()
            .filter(|watch| watch.due <= now)
            .collect();
        stale.truncate(MAX_REFRESHES_PER_ALARM);
        if stale.is_empty() {
            return Ok(());
        }
        let Some(config) = reader_config(&self.env, &sql) else {
            return Ok(());
        };
        let room = rows(&sql, "SELECT id FROM workspace", vec![])?
            .first()
            .and_then(|row| text(&row["id"]))
            .unwrap_or_default();
        let reader = AgentTokens::new(config);
        for watch in stale {
            let now = now_ms();
            // Over the cap, the read is dropped. The next poll catches up.
            if !self.in_transaction(move |sql| count_read(sql, None, now))? {
                break;
            }
            let read = reader.read_pull(watch.repo_id, watch.number).await;
            note_unrevoked(&read, &room, &watch.task_id);
            let (room, answer, at_mint) = (room.clone(), read.answer, read.failed_at_mint);
            let (task_id, repo_id) = (watch.task_id.clone(), watch.repo_id);
            let refused = self.in_transaction({
                let room = room.clone();
                move |sql| apply_read(sql, &room, &watch, answer, at_mint, now_ms())
            })?;
            if refused {
                break;
            }
            // The head commit's checks, where the App that reads has been given them (M5 step 8). Best effort: a
            // read that fails leaves what was held, with its older time.
            if reads_checks(&self.env, &sql) {
                let head = change_row(&sql, &task_id)?
                    .filter(|row| row["pr_state"].as_str() == Some("open"))
                    .and_then(|row| text(&row["observed_head_sha"]));
                // It counts against the repository's hourly read cap like any read. Over it, the checks wait.
                let counted = head.is_some()
                    && self.in_transaction(move |sql| count_read(sql, None, now_ms()))?;
                if let Some(head) = head.filter(|_| counted) {
                    let read = reader.read_checks(repo_id, &head).await;
                    if !read.revoked {
                        console_error!(
                            "{}",
                            json!({ "event": "task_change.token_unrevoked", "ws": room, "task": task_id })
                        );
                    }
                    match read.answer {
                        Ok(seen) => self.in_transaction(move |sql| {
                            apply_checks(sql, &task_id, &head, &seen, now_ms())
                        })?,
                        Err(failure) => {
                            console_error!(
                                "{}",
                                json!({ "event": "task_change.checks_read_failed", "ws": room, "task": task_id, "status": failure.status() })
                            );
                            if let Some(wait) = failure.rate_limit_wait_ms() {
                                let until = now_ms() + wait;
                                self.in_transaction(move |sql| hold_reads(sql, repo_id, until))?;
                                break;
                            }
                        }
                    }
                }
            }
        }
        Ok(())
    }
}

/// Whether the refresh job also reads a head commit's statuses and check runs. Off unless the Worker's
/// `GITHUB_AGENT_APP_READS_CHECKS` is exactly `true`, which the owner sets once the agent-token App has been given
/// `statuses: read` and `checks: read`. Until then a token for them can't be minted, so nothing is asked. Test builds
/// can switch it on for one room.
fn reads_checks(env: &Env, sql: &SqlStorage) -> bool {
    #[cfg(feature = "failpoints")]
    if rows(
        sql,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_reads_checks'",
        vec![],
    )
    .is_ok_and(|found| !found.is_empty())
    {
        return true;
    }
    #[cfg(not(feature = "failpoints"))]
    let _ = sql;
    env.var("GITHUB_AGENT_APP_READS_CHECKS")
        .is_ok_and(|value| value.to_string() == "true")
}

/// Records what a read of the head commit's checks showed, in the caller's transaction: the state, the counts and the
/// time, and an event when the state is a different one. Only if the head is still the one that was read for.
fn apply_checks(sql: &SqlStorage, task_id: &str, head: &str, seen: &ChecksSeen, now: i64) -> R<()> {
    let Some(row) =
        change_row(sql, task_id)?.filter(|row| row["observed_head_sha"].as_str() == Some(head))
    else {
        return Ok(());
    };
    let states: Vec<CheckSeen> = seen
        .iter()
        .map(|(state, conclusion)| CheckSeen {
            state,
            conclusion: conclusion.as_deref(),
        })
        .collect();
    let (state, counts) = summarize_checks(&states);
    let changed = row["checks_state"].as_str() != Some(state.name());
    exec(
        sql,
        "UPDATE task_change SET checks_state = ?, checks_json = ?, checks_observed_at = ? WHERE task_id = ?",
        vec![
            state.name().into(),
            // With the commit they were read for, so they're never shown beside another.
            json!({ "sha": head, "success": counts.success, "failure": counts.failure, "pending": counts.pending })
                .to_string()
                .into(),
            now.into(),
            task_id.into(),
        ],
    )?;
    if changed {
        record_event(
            sql,
            "task_change.checks_observed",
            SYSTEM,
            Some(task_id),
            &Transition {
                reason: Some(state.name()),
                ..Transition::NONE
            },
            Vec::<String>::new(),
            now,
        )?;
    }
    Ok(())
}

/// What a task's release status needs from outside the room's rows (M6 step 7): the deployment's release switch, the
/// content domain, and the stop for the whole content domain. Asked only after the caller is authorized, and the stop
/// only for a caller shown the task's change while the room has a release of the task's merged commit recorded
/// `served`, since nothing else could be shown served; unasked, it reads as stopped.
pub(super) struct ReleaseFacts {
    pub(super) switched_on: bool,
    pub(super) domain: Option<String>,
    pub(super) stop: StopSeen,
}

/// Who may read the task's release status, and whether they are shown the task's change (`true`) or given the merge
/// alone, by `podster_policy::repositories::authorize_release_status` on the room's rows. Refused callers are answered
/// here, before anything outside the room is asked.
fn release_status_view(sql: &SqlStorage, who: &Participant, task_id: &str) -> R<bool> {
    let task = load_task(sql, task_id)?.ok_or_else(ApiError::task_not_found)?;
    let asked = change_row(sql, task_id)?
        .is_some_and(|row| row["merge_requested_by"].as_str() == Some(who.caller.id.as_str()));
    let view = podster_policy::repositories::authorize_release_status(&who.caller, &task, asked)
        .map_err(repositories::denied)?;
    Ok(view == podster_policy::repositories::ReleaseView::Whole)
}

impl Workspace {
    pub(super) async fn release_status_facts(
        &self,
        sql: &SqlStorage,
        who: &Participant,
        task_id: &str,
    ) -> R<ReleaseFacts> {
        // Authorize first: a caller who is refused causes no read of the switch or the stop.
        let whole = release_status_view(sql, who, task_id)?;
        let switched_on = crate::releases::switched_on(&self.env).await;
        // A row that can't be read here is read again by the status itself, which then refuses; the stop is asked
        // anyway, so nothing is shown served on a guess.
        // Nothing can be shown served while the room's release is off or the room isn't public, so the stop isn't asked.
        let candidate = whole
            && switched_on
            && room_release_on(sql).unwrap_or(true)
            && room_public(sql).unwrap_or(true)
            && served_attempt(sql, task_id).unwrap_or(true);
        let stop = if candidate {
            match crate::content_stop::read_from(&self.env).await {
                crate::content_stop::Stop::Clear => StopSeen::Clear,
                crate::content_stop::Stop::Stopped => StopSeen::Stopped,
                crate::content_stop::Stop::Unreadable => StopSeen::Unread,
            }
        } else {
            StopSeen::Unread
        };
        Ok(ReleaseFacts {
            switched_on,
            domain: crate::content_provider::content_domain(&self.env),
            stop,
        })
    }
}

/// The task's merged commit, from its change: the commit a release of the task names.
fn merged_commit(sql: &SqlStorage, task_id: &str) -> R<Option<String>> {
    Ok(change_row(sql, task_id)?.and_then(|row| text(&row["merge_sha"])))
}

/// Whether the room's own release setting is on.
fn room_release_on(sql: &SqlStorage) -> R<bool> {
    Ok(rows(sql, "SELECT enabled FROM release_config", vec![])?
        .first()
        .is_some_and(|row| int(&row["enabled"]) == 1))
}

/// Whether the room is public now, by its own row. Only a public room's app is served.
fn room_public(sql: &SqlStorage) -> R<bool> {
    Ok(rows(sql, "SELECT visibility FROM workspace", vec![])?
        .first()
        .is_some_and(|row| row["visibility"].as_str() == Some("public")))
}

/// Whether any release of the task's merged commit is recorded `served`.
fn served_attempt(sql: &SqlStorage, task_id: &str) -> R<bool> {
    let Some(commit) = merged_commit(sql, task_id)? else {
        return Ok(false);
    };
    Ok(!rows(
        sql,
        "SELECT id FROM release WHERE task_id = ? AND commit_sha = ? AND state = 'served' LIMIT 1",
        vec![task_id.into(), commit.as_str().into()],
    )?
    .is_empty())
}

/// The release part of a task's release status (M6 step 7), as `podster_core::release_status::release_report` decides
/// it from the room's rows: `{ exists: false }` while release is off for the deployment or the room, or while nothing
/// was asked for the task's merged commit; otherwise the latest attempt, with `served` and the default host's address
/// only while the commit is what that host serves. Whoever is given the merge alone gets `null` while release is on, and
/// while it is off the same `{ exists: false }` as everyone, which is what every caller was answered before M6.
fn release_part(sql: &SqlStorage, task_id: &str, facts: &ReleaseFacts, whole: bool) -> R<Value> {
    let none = json!({ "exists": false });
    let room_on = room_release_on(sql)?;
    if !whole {
        return Ok(if facts.switched_on && room_on {
            Value::Null
        } else {
            none
        });
    }
    let Some(commit) = merged_commit(sql, task_id)? else {
        return Ok(none);
    };
    let attempts = rows(
        sql,
        "SELECT id, state, script_name, updated_at, failure_code FROM release WHERE task_id = ? AND commit_sha = ? ORDER BY seq",
        vec![task_id.into(), commit.as_str().into()],
    )?;
    let host = rows(
        sql,
        "SELECT label, script_name FROM serve_state WHERE kind = 'default' AND host NOT IN (SELECT host FROM serve_retired)",
        vec![],
    )?;
    let host = host.first();
    let held = rows(sql, "SELECT cause FROM release_hold", vec![])?
        .first()
        .is_some_and(|row| !row["cause"].is_null());
    // On any label the room ever had: a suspension unpublishes, which retires the label it was on (2026-11-23).
    let app_suspended = super::takedown::app_suspended(sql)?;
    let held_attempts: Vec<AttemptHeld> = attempts
        .iter()
        .map(|row| AttemptHeld {
            id: row["id"].as_str().unwrap_or_default(),
            state: row["state"].as_str().unwrap_or_default(),
            script_name: row["script_name"].as_str(),
            recorded_at: int(&row["updated_at"]),
            failure_code: row["failure_code"].as_str(),
        })
        .collect();
    let host_held = HostHeld {
        default_script: host.and_then(|row| row["script_name"].as_str()),
        held,
        app_suspended,
        room_public: room_public(sql)?,
        stop: facts.stop,
    };
    // A stored state the room doesn't recognise refuses the read: it is never guessed at, and never served.
    let report = release_report(facts.switched_on && room_on, &held_attempts, &host_held)
        .map_err(|_| ApiError::internal("release state unknown"))?;
    Ok(match report {
        ReleaseReport::NoRelease => none,
        ReleaseReport::Attempt {
            id,
            state,
            observed_at,
            failure_code,
            served,
        } => {
            // The address is the default host's, only while the commit is what it serves.
            let label = host.and_then(|row| row["label"].as_str());
            let result_url = match (served, label, facts.domain.as_deref()) {
                (true, Some(label), Some(domain)) => json!(format!("https://{label}.{domain}/")),
                _ => Value::Null,
            };
            // Why it waits, a word from core's closed set, only while it does: never the job's code itself.
            let job = rows(
                sql,
                "SELECT leased_step, last_code FROM release_job WHERE release_id = ?",
                vec![id.into()],
            )?;
            let waiting = release_waiting(
                state,
                job.first().map(|row| JobHeld {
                    leased: !row["leased_step"].is_null(),
                    last_code: row["last_code"].as_str(),
                }),
            )
            .map(ReleaseWaiting::name);
            json!({
                "exists": true, "release_id": id, "commit_sha": commit, "state": state.name(),
                "observed_at": observed_at, "failure_code": failure_code, "served": served, "result_url": result_url,
                "waiting": waiting,
            })
        }
    })
}

/// `GET tasks/{task}/release-status` (M5 step 8, M6 step 7): the task's checks, its merge and its release, apart, each
/// as Podster last observed it and with that observation's time. Read from the room's own rows: nothing is asked of
/// GitHub. For whoever is shown the task's change, and whoever asked for its merge, who is given the merge alone.
pub(super) fn release_status(
    sql: &SqlStorage,
    who: &Participant,
    task_id: &str,
    facts: &ReleaseFacts,
) -> R<Value> {
    // Decided again on the same rows, in the same turn as the facts were read.
    let whole = release_status_view(sql, who, task_id)?;
    let task = load_task(sql, task_id)?.ok_or_else(ApiError::task_not_found)?;
    let row = change_row(sql, task_id)?;
    // Checks are reported only for the commit they were read for. If the head is another now, they're unobserved.
    let stored = row
        .as_ref()
        .and_then(|row| row["checks_json"].as_str())
        .and_then(|stored| serde_json::from_str::<Value>(stored).ok());
    let checks_sha = stored.as_ref().and_then(|stored| text(&stored["sha"]));
    let for_this_head = row.as_ref().is_some_and(|row| {
        checks_sha.is_some() && checks_sha.as_deref() == row["observed_head_sha"].as_str()
    });
    let held = row.as_ref().map(|row| podster_core::release_status::Held {
        checks_state: row["checks_state"].as_str().filter(|_| for_this_head),
        checks_observed_at: row["checks_observed_at"].as_i64(),
        merge_state: row["merge_state"].as_str(),
        merge_reason: row["merge_reason"].as_str(),
        merge_finished_at: row["merge_finished_at"].as_i64(),
        merge_observed_at: row["merge_observed_at"].as_i64(),
        merge_requested_at: row["merge_requested_at"].as_i64(),
    });
    let (checks, merge) = report(held.as_ref());
    let checks = match checks {
        ChecksReport::Unobserved => {
            json!({ "state": Value::Null, "counts": Value::Null, "observed_at": Value::Null, "commit_sha": Value::Null })
        }
        ChecksReport::Observed { state, at } => {
            // The counts are Podster's own, written with the state. Anything else in that column isn't shown.
            let counts = stored.as_ref().map(|stored| json!({ "success": stored["success"].as_u64().unwrap_or(0), "failure": stored["failure"].as_u64().unwrap_or(0), "pending": stored["pending"].as_u64().unwrap_or(0) }));
            json!({ "state": state.name(), "counts": counts, "observed_at": at, "commit_sha": checks_sha })
        }
    };
    let pull = row.as_ref().map_or(Value::Null, |row| {
        json!({
            "pr_number": row["pr_number"], "pr_state": row["pr_state"], "pr_observed_at": row["pr_observed_at"],
            "reviewed_commit_sha": row["reviewed_commit_sha"], "observed_head_sha": row["observed_head_sha"],
            "head_observed_at": row["head_observed_at"], "commit_changed": row["commit_changed_at"].as_i64().is_some(),
        })
    });
    // Whoever asked for the merge and isn't shown the task's change gets how the merge went, and nothing of the pull
    // request or its checks: never more than their view of the change shows.
    let release = release_part(sql, task_id, facts, whole)?;
    let (pull, checks) = if whole {
        (pull, checks)
    } else {
        (Value::Null, Value::Null)
    };
    Ok(json!({
        "task_id": task.id,
        "linked": task.has_linked_repository,
        "pull_request": pull,
        "checks": checks,
        "merge": {
            "state": merge.state.name(), "reason": merge.reason, "observed_at": merge.observed_at,
            "sha": row.as_ref().map_or(Value::Null, |row| row["merge_sha"].clone()),
            "requested_by": row.as_ref().map_or(Value::Null, |row| row["merge_requested_by"].clone()),
        },
        "release": release,
    }))
}
