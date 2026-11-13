//! The room's recheck of a release (M6 step 5, first PR; ADR 0010's "The release job", step 1).
//!
//! "Rerun policy and recheck authority, on every pass, in the room's transaction, against current state": a job that
//! passed once doesn't keep its permission. This is that recheck and nothing else. It gathers every fact
//! `podster_core::release::recheck` asks for, from current state, runs it, and **fails the release when it doesn't
//! hold,** with core's own reason. Starting an upload and committing live are [`release_commit`]'s, on top of it.
//!
//! **Where each fact is read.**
//! - **The room's own rows, inside the transaction:** archived, public, the public surface's and the app's suspension,
//!   release on in the room and its configuration's version, the epoch, the repository's link, the release's commit
//!   against the room's own merge record and its task, the reviewer rule, the requester's and the approver's place in
//!   the room, and the requester's `deploy` grant.
//! - **Another object, asked before the transaction** ([`Workspace::release_reads`]): the stop for the whole content
//!   domain, from the `Moderation` object; whether the room's organization holds the provisioning delegation, from the
//!   organization's own object; and, from each person's own `Principal`, whether the approver, the requester and the
//!   grant's giver have left the organization their place here is held in. And the deployment's switch.
//! - **Checked again inside:** each of those answers is about a named organization or person. Inside the transaction
//!   the room reads who they are now, and an answer about anyone else says nothing of them.
//!
//! **A fact that couldn't be read is undecided, never failed.** Only a fact that was read and doesn't hold fails a
//! release, which can't be undone. The stop unreadable, an organization's or a person's record that doesn't answer,
//! an answer that isn't the shape expected, an answer about someone the rows no longer name, and someone the rows
//! make worth asking about now who wasn't when the questions were asked, as when they were made an admin in between:
//! each is a fact that wasn't read.
//!
//! **What is read first, and what one unread fact can hide: nothing** (second PR). The release's own state is read
//! before anything is asked of anyone, so one that has ended answers as ended with no outside read. The outside reads
//! never stop at the first that fails to answer. And inside the transaction every unread fact is taken as holding
//! while core decides: a failure core then finds comes from a fact that was read, and ends the release whatever else
//! is unread. Only when nothing fails does an unread fact that matters make the pass `standing_unknown`, which the
//! job retries, and which writes nothing.
//!
//! **Nothing here reads D1 or any read model.**
//!
//! **Facts with no source yet, said plainly:**
//! - *The organization deleted, and the room deleted.* Nothing deletes either. `organization_exists` is always true and
//!   `deleted` is true only for a room whose status is neither active nor archived, which nothing sets.
//! - *An agent that asked for the release.* The release keeps who asked and not the person who controls them, so
//!   whether that person still holds can't be asked. An agent's release fails here, `requester_lost_authority`, until
//!   the step that takes a release's request (step 6) records it.
//! - *Whether the task was reviewed under the room's person-reviewer rule.* It isn't recorded. What is checked is that
//!   the release meets the rule the room has now: if the room requires a person as reviewer, the task's reviewer was
//!   one.
//!
//! **The organization's provisioning delegation is read as `organization_may_provision`,** which only refuses
//! (decision 218, part 1): an operator who takes it back stops that organization's new releases and commits, answered
//! `release_not_delegated`, and unpublishes nothing. **`organization_may_release` is decision 218's release switch,**
//! the unpublish trigger. It isn't read yet, so it holds, as it does for an organization with no record of it.
//!
//! Logs carry the room's and the release's IDs and codes.
use super::*;
use crate::content_stop::{self, Stop};
use podster_core::release::{
    is_release_id, recheck, CommitRecord, Recheck, ReleaseState, RoomReleaseFacts,
};
use podster_policy::release::{
    authorize_approval, delegation_holder, may_release_now, DeployGrant, ReleaseRoom,
    ReleaseStanding, DEPLOY_ACTION,
};

/// The room's path for one pass of the recheck. Nothing outside the Worker reaches it, and nothing calls it yet.
pub(crate) const INTERNAL_RELEASE_RECHECK: &str = "/internal/release-recheck";

pub(super) fn standing_unknown() -> ApiError {
    ApiError::api(503, "standing_unknown")
}

/// One question asked of someone's own `Principal` outside the room's transaction: who it was about, and whether they
/// still hold. `who` is `None` when there was nobody to ask about. `asked` is whether their `Principal` was asked at
/// all: nobody is asked about someone the room's rows didn't make worth asking about. `holds` is `None` when they were
/// asked and gave no answer that says either.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Asked {
    who: Option<String>,
    asked: bool,
    /// The place the question was about: the organization their place in the room is held in, and since when. The
    /// answer says nothing of any other place.
    place: Option<(String, i64)>,
    holds: Option<bool>,
}

/// Everything a pass learns outside the room. Never taken from a request. **Each fact is `None` when it couldn't be
/// read,** and the reads never stop at the first that couldn't: a fact that was read and fails still fails the
/// release, whatever else gave no answer.
pub(super) struct Reads {
    /// When the first of these was asked, by the room's clock. A commit's confirm refuses reads older than
    /// `release_commit::MAX_READ_AGE_MS`.
    read_at: i64,
    deployment_on: Option<bool>,
    /// The stop, as the `Moderation` object said it.
    stopped: Option<bool>,
    /// The organization the delegation was read for, the provider it was read for, and whether the organization
    /// holds it. With no repository linked there is no provider to ask about, and nothing was asked.
    org: String,
    provider: Option<String>,
    org_may_release: Option<bool>,
    approver: Asked,
    requester: Asked,
    giver: Asked,
}

impl Reads {
    /// Nothing read at all: every outside fact unknown. A pass given this decides only from the room's own rows, and
    /// can fail a release on them but never hold.
    pub(super) fn nothing() -> Reads {
        let nobody = || Asked {
            who: None,
            asked: false,
            place: None,
            holds: None,
        };
        Reads {
            read_at: i64::MIN,
            deployment_on: None,
            stopped: None,
            org: String::new(),
            provider: None,
            org_may_release: None,
            approver: nobody(),
            requester: nobody(),
            giver: nobody(),
        }
    }
}

impl Reads {
    /// How long ago the first of these was asked, at `now`.
    pub(super) fn age(&self, now: i64) -> i64 {
        now.saturating_sub(self.read_at)
    }
}

/// The time a release command decides by: the clock. Test builds read it from a table a test makes in the room,
/// `test_release_clock`, when there is one, so a bound can be shown at exactly its edge and without waiting.
pub(super) fn release_now(sql: &SqlStorage) -> i64 {
    #[cfg(feature = "failpoints")]
    if rows(
        sql,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_release_clock'",
        vec![],
    )
    .is_ok_and(|found| !found.is_empty())
    {
        if let Some(now) = rows(sql, "SELECT now FROM test_release_clock", vec![])
            .ok()
            .and_then(|found| found.first().map(|row| int(&row["now"])))
        {
            return now;
        }
    }
    let _ = sql;
    now_ms()
}

/// What one pass concludes. `Unknown` only when every fact that was read holds and at least one that matters wasn't.
pub(super) enum Verdict {
    Holds,
    Fails(&'static str),
    Unknown,
}

/// The requester's live `deploy` grant on the room's linked repository, as the room's row has it: not revoked, not
/// past its expiry at `now`, for the action, and for the repository and the provider the room's link names. A grant
/// on any other repository isn't looked at: with no repository linked, there is none. The room keeps at most one
/// unrevoked grant for a principal, a repository and an action, so there is one such row or none.
struct GrantRow {
    provider_repo_id: i64,
    delegated_by: String,
    expires_at: Option<i64>,
}

fn deploy_grant(sql: &SqlStorage, principal: &str, now: i64) -> R<Option<GrantRow>> {
    Ok(rows(
        sql,
        "SELECT g.provider_repo_id, g.delegated_by, g.expires_at FROM provider_grant g
           JOIN repo_link l ON l.provider_repo_id = g.provider_repo_id AND l.provider = g.provider
           WHERE g.principal_id = ? AND g.action = ? AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > ?)
           ORDER BY g.created_at, g.id LIMIT 1",
        vec![principal.into(), DEPLOY_ACTION.into(), now.into()],
    )?
    .first()
    .and_then(|row| {
        Some(GrantRow {
            provider_repo_id: int(&row["provider_repo_id"]),
            delegated_by: text(&row["delegated_by"])?,
            expires_at: (!row["expires_at"].is_null()).then(|| int(&row["expires_at"])),
        })
    }))
}

/// Whether someone is worth asking their own `Principal` about, by the room's rows now: a person the room records,
/// and, with `authority_only`, one who is its owner or an admin. Nobody else holds, whatever a `Principal` would say.
fn worth_asking(
    sql: &SqlStorage,
    who: &str,
    authority_only: bool,
) -> R<Option<repositories::GiverRecord>> {
    Ok(repositories::recorded_giver(sql, who)?.filter(|record| {
        record.kind == PrincipalKind::Person
            && (!authority_only || matches!(record.role, Role::Owner | Role::Admin))
    }))
}

/// The provider the room's repository is with, if it has one linked.
fn linked_provider(sql: &SqlStorage) -> R<Option<String>> {
    Ok(rows(sql, "SELECT provider FROM repo_link", vec![])?
        .first()
        .and_then(|link| text(&link["provider"])))
}

/// Who the three questions are about, from the room's rows as they are now: the release's approver, whoever asked for
/// it, and whoever gave the requester their `deploy` grant.
struct People {
    approver: Option<String>,
    requester: String,
    giver: Option<String>,
}

fn people(sql: &SqlStorage, release: &str, now: i64) -> R<Option<People>> {
    let found = rows(
        sql,
        "SELECT requested_by, approved_by FROM release WHERE id = ?",
        vec![release.into()],
    )?;
    let Some(row) = found.first() else {
        return Ok(None);
    };
    let requester = text(&row["requested_by"]).unwrap_or_default();
    let giver = deploy_grant(sql, &requester, now)?.map(|grant| grant.delegated_by);
    Ok(Some(People {
        approver: text(&row["approved_by"]),
        requester,
        giver,
    }))
}

/// What the room and the others say of whether release may happen here at all, for policy and for core alike.
fn room_facts(sql: &SqlStorage, deployment_on: bool, org_may_release: bool) -> R<RoomReleaseFacts> {
    let room = rows(
        sql,
        "SELECT status, visibility, suspended_at FROM workspace",
        vec![],
    )?;
    let room = room
        .first()
        .ok_or_else(|| ApiError::internal("no workspace row"))?;
    let status = room["status"].as_str().unwrap_or_default();
    let enabled = rows(sql, "SELECT enabled FROM release_config", vec![])?
        .first()
        .is_some_and(|config| int(&config["enabled"]) == 1);
    let repository_ready = !rows(
        sql,
        "SELECT 1 AS ready FROM repo_link WHERE status = 'ready'",
        vec![],
    )?
    .is_empty();
    Ok(RoomReleaseFacts {
        release_on_in_room: enabled,
        deployment_allows_release: deployment_on,
        archived: status == ARCHIVED,
        // Nothing deletes a room yet. A status that is neither of the two there are would be one that had been.
        deleted: status != ACTIVE_ROOM && status != ARCHIVED,
        public: room["visibility"].as_str() == Some("public"),
        // Nothing deletes an organization, so there is nothing that could say one was: no object records it and no
        // command does it. Whatever first deletes one owes this fact its source, and the trigger that unpublishes.
        organization_exists: true,
        public_surface_suspended: !room["suspended_at"].is_null(),
        app_suspended: takedown::app_suspended(sql)?,
        organization_may_release: org_may_release,
        repository_ready,
        // Set by the caller, from the requester's own standing: see `gather`.
        someone_may_release: false,
    })
}

/// One recheck's inputs as core takes them, with the strings it borrows.
struct Gathered {
    room: RoomReleaseFacts,
    organization_may_provision: bool,
    domain_stopped: bool,
    config_version_now: u64,
    config_version_asked: u64,
    requester_may_release_now: bool,
    approver_may_approve_now: bool,
    reviewer_rule_holds: bool,
    commit: Option<(String, i64, bool, bool, bool)>,
    asked_sha: String,
    room_repo_id: i64,
    epoch_now: u64,
    epoch_at_start: u64,
}

fn as_u64(value: &Value) -> u64 {
    int(value).max(0) as u64
}

/// What an answer from outside says of whoever the room's rows name now: `Some` if it is about them and says whether
/// they hold, `None` if it says nothing of them. It says nothing when it was about someone else, when their
/// `Principal` gave no answer, when they weren't asked though the rows make them worth asking about now, as someone
/// made an admin, or added to the room, since the questions were asked, and when the question was about another
/// place than the one the rows give them now: another organization, or a place that began at another time.
fn settled(
    sql: &SqlStorage,
    answer: &Asked,
    now_who: Option<&str>,
    authority_only: bool,
) -> R<Option<bool>> {
    if answer.who.as_deref() != now_who {
        return Ok(None);
    }
    let Some(who) = now_who else {
        // Nobody to ask about, and nobody holds.
        return Ok(Some(false));
    };
    let place = worth_asking(sql, who, authority_only)?.map(|record| (record.org, record.since));
    if !answer.asked {
        return Ok(match place {
            Some(_) => None,
            None => Some(false),
        });
    }
    // Asked about one place in the room. If the rows give them another now, or none, the answer isn't about it.
    Ok(match place {
        None => Some(false),
        Some(place) if Some(&place) == answer.place.as_ref() => answer.holds,
        Some(_) => None,
    })
}

/// Gathers every fact, inside the room's transaction, from the room's rows now and what was read outside. The second
/// value is whether a fact that matters is unknown.
///
/// **An unknown fact is taken as holding, and remembered.** Every unknown is assumed in the direction that lets the
/// release go on, so a failure core then finds can only come from a fact that was read: it stands, whatever else is
/// unknown. If core finds none, the remembered unknown makes the pass undecided. An unknown about a person is only
/// remembered when it matters: someone who fails on the room's own rows fails, whatever their `Principal` would say.
fn gather(sql: &SqlStorage, release: &Value, reads: &Reads, now: i64) -> R<(Gathered, bool)> {
    let id = release["id"].as_str().unwrap_or_default();
    let People {
        approver,
        requester,
        giver,
    } = people(sql, id, now)?.ok_or_else(ApiError::not_found)?;
    let mut unknown = false;
    let mut or_assume = |fact: Option<bool>, assumed: bool| {
        fact.unwrap_or_else(|| {
            unknown = true;
            assumed
        })
    };
    let deployment_on = or_assume(reads.deployment_on, true);
    let stopped = or_assume(reads.stopped, false);
    // The delegation was read for an organization and a provider. Read for another, it says nothing of this one.
    let about_this_room =
        reads.org == room_owner_org(sql)? && reads.provider == linked_provider(sql)?;
    let org_may_release = or_assume(reads.org_may_release.filter(|_| about_this_room), true);
    let approver_holds = settled(sql, &reads.approver, approver.as_deref(), true)?;
    let requester_holds = settled(sql, &reads.requester, Some(&requester), false)?;
    let giver_holds = settled(sql, &reads.giver, giver.as_deref(), true)?;
    // Decision 218's release switch isn't read yet: an organization with no record holds it, so it holds here. What is
    // read is the provisioning delegation, which only refuses.
    let mut room = room_facts(sql, deployment_on, true)?;
    let link_repo_id = rows(sql, "SELECT provider_repo_id FROM repo_link", vec![])?
        .first()
        .map_or(0, |link| int(&link["provider_repo_id"]));
    let release_room = ReleaseRoom {
        deployment_allows_release: room.deployment_allows_release,
        organization_may_release: room.organization_may_release,
        organization_may_provision: org_may_release,
        public: room.public,
        archived: room.archived,
        public_surface_suspended: room.public_surface_suspended,
        app_suspended: room.app_suspended,
        release_on_in_room: room.release_on_in_room,
        deleted: room.deleted,
        organization_exists: room.organization_exists,
        repository_ready: room.repository_ready,
    };

    // Whoever asked: in the room now, not through a public claim, holding a `deploy` grant that counts, from a giver
    // who still holds release authority. A person must not have left their organization. An agent can't be shown to
    // be controlled by anyone who still holds, so it may not (see the module's note).
    let record = repositories::recorded_giver(sql, &requester)?;
    let (kind, role) = record
        .as_ref()
        .map_or((parse_kind_of(&requester), Role::None), |r| {
            (r.kind, r.role)
        });
    let grant = deploy_grant(sql, &requester, now)?;
    let holder = match (&grant, &giver) {
        (Some(_), Some(giver)) => repositories::recorded_giver(sql, giver)?
            .and_then(|g| delegation_holder(giver, g.kind, g.role, giver_holds.unwrap_or(true))),
        _ => None,
    };
    let grant = grant.as_ref().map(|g| DeployGrant {
        principal: &requester,
        action: DEPLOY_ACTION,
        provider_repo_id: g.provider_repo_id,
        delegated_by: &g.delegated_by,
        expires_at: g.expires_at,
        revoked_at: None,
    });
    let standing = ReleaseStanding {
        grant: grant.as_ref(),
        link_repo_id,
        delegation_holder: holder,
        through_public_claim: public_claims::is_public_participant(sql, &requester)?,
        agent_connected: false,
        now,
    };
    let requester_may_release_now = may_release_now(&requester, kind, role, &standing).is_ok()
        && kind == PrincipalKind::Person
        && requester_holds.unwrap_or(true);
    // Unknown matters only where the answer would be yes on everything that is known.
    if requester_may_release_now && (requester_holds.is_none() || giver_holds.is_none()) {
        unknown = true;
    }
    // The recheck asks whether anyone at all may release only after it has asked whether the requester may, so the
    // requester's own answer is the one that can matter here. Who else may is the unpublish trigger's question.
    room.someone_may_release = requester_may_release_now;

    // Whoever approved: a person who is the room's owner or a room admin now, with that authority holding, where
    // release may happen now.
    let approver_may_approve_now = match &approver {
        Some(approver) => {
            let record = repositories::recorded_giver(sql, approver)?;
            let caller = Caller {
                id: approver.clone(),
                kind: record.as_ref().map_or(parse_kind_of(approver), |r| r.kind),
                role: record.as_ref().map_or(Role::None, |r| r.role),
                scopes: Scopes::PUBLIC_PARTICIPANT,
            };
            authorize_approval(&caller, approver_holds.unwrap_or(true), &release_room).is_ok()
        }
        None => false,
    };
    if approver_may_approve_now && approver_holds.is_none() {
        unknown = true;
    }

    // The commit, by the room's own merge record for the release's task: Podster's merge job merged it and read it
    // back, in the repository that record names, and the task is completed.
    //
    // "Merged by Podster" is two things in that record. `succeeded` is written in one place only, by Podster's merge
    // job, on core's proof that it read the pull request back as merged with the default branch holding the reviewed
    // commit. `merge_called_at` says that job itself called the merge.
    //
    // **What the two don't say is whose call merged it.** If Podster's call is on record but its outcome wasn't
    // known, and a person then merged the same pull request by hand, the job reads it back as merged and records
    // `succeeded` all the same: that reads here as merged by Podster. `merged_by_id` is who the provider says merged,
    // and the room keeps no ID of the merge App's own account to compare it with.
    //
    // **A release doesn't need to care, and this doesn't.** What is released is the commit, and in that case it is
    // still the one a reviewer accepted, on the default branch of the room's own repository, for a completed task,
    // through a merge Podster itself decided to make and called, with every check it makes before calling. Whose
    // request reached the provider first changes nothing that is published. A commit merged with no call of
    // Podster's on record is refused, as before.
    let task = text(&release["task_id"]).unwrap_or_default();
    let change = rows(
        sql,
        "SELECT c.merge_sha, c.provider_repo_id, c.merge_state, c.merge_called_at, c.merge_finished_at, c.reviewer_id, t.status
           FROM task_change c JOIN task t ON t.id = c.task_id WHERE c.task_id = ?",
        vec![task.as_str().into()],
    )?;
    let change = change.first();
    let commit = change.and_then(|row| {
        let succeeded = row["merge_state"].as_str() == Some("succeeded");
        Some((
            text(&row["merge_sha"])?,
            int(&row["provider_repo_id"]),
            succeeded && !row["merge_called_at"].is_null(),
            succeeded && !row["merge_finished_at"].is_null(),
            row["status"].as_str() == Some("completed"),
        ))
    });
    // The rule the room has now: if it requires a person as reviewer, the task's reviewer was one.
    let reviewer_rule_holds = !store::requires_person_review(sql)?
        || change
            .and_then(|row| row["reviewer_id"].as_str())
            .is_some_and(|reviewer| parse_kind_of(reviewer) == PrincipalKind::Person);

    let config = rows(
        sql,
        "SELECT version, release_epoch FROM release_config",
        vec![],
    )?;
    let config = config.first();
    let gathered = Gathered {
        room,
        organization_may_provision: org_may_release,
        domain_stopped: stopped,
        config_version_now: config.map_or(0, |c| as_u64(&c["version"])),
        config_version_asked: as_u64(&release["config_version"]),
        requester_may_release_now,
        approver_may_approve_now,
        reviewer_rule_holds,
        commit,
        asked_sha: text(&release["commit_sha"]).unwrap_or_default(),
        room_repo_id: link_repo_id,
        // An epoch the room doesn't have is never the one a release started under.
        epoch_now: config.map_or(u64::MAX, |c| as_u64(&c["release_epoch"])),
        epoch_at_start: as_u64(&release["release_epoch"]),
    };
    Ok((gathered, unknown))
}

/// A release's row, as the commands here read it.
pub(super) const RELEASE_COLUMNS: &str = "id, state, task_id, commit_sha, config_version, release_epoch, label, script_name, script_release_id, failure_code";

pub(super) fn release_row(sql: &SqlStorage, release_id: &str) -> R<Option<Value>> {
    Ok(rows(
        sql,
        &format!("SELECT {RELEASE_COLUMNS} FROM release WHERE id = ?"),
        vec![release_id.into()],
    )?
    .into_iter()
    .next())
}

pub(super) fn state_of(release: &Value) -> R<ReleaseState> {
    release["state"]
        .as_str()
        .and_then(|name| ReleaseState::ALL.into_iter().find(|s| s.name() == name))
        .ok_or_else(|| ApiError::internal("a release in no state"))
}

/// Whether the job owns a release: once it is approved and until the room has committed it live. Before that there is
/// no approver to ask about. After it, the release is the room's and its marker's.
pub(super) fn job_owns(state: ReleaseState) -> bool {
    matches!(
        state,
        ReleaseState::Queued | ReleaseState::Uploading | ReleaseState::Uncertain
    )
}

/// Every fact, and core's recheck of them, inside the room's transaction.
pub(super) fn judge(sql: &SqlStorage, release: &Value, reads: &Reads, now: i64) -> R<Verdict> {
    let (facts, unknown) = gather(sql, release, reads, now)?;
    let commit = facts.commit.as_ref().map(|c| CommitRecord {
        sha: &c.0,
        provider_repo_id: c.1,
        merged_by_podster: c.2,
        confirmed_on_default_branch: c.3,
        task_completed: c.4,
    });
    Ok(
        match recheck(&Recheck {
            room: facts.room,
            organization_may_provision: facts.organization_may_provision,
            domain_stopped: facts.domain_stopped,
            config_version_now: facts.config_version_now,
            config_version_asked: facts.config_version_asked,
            requester_may_release_now: facts.requester_may_release_now,
            approver_may_approve_now: facts.approver_may_approve_now,
            reviewer_rule_holds: facts.reviewer_rule_holds,
            commit: commit.as_ref(),
            asked_sha: &facts.asked_sha,
            room_repo_id: facts.room_repo_id,
            epoch_now: facts.epoch_now,
            epoch_at_start: facts.epoch_at_start,
        }) {
            // A failure stands whatever is unknown: every unknown was taken as holding.
            Err(failure) => Verdict::Fails(failure.code()),
            Ok(()) if unknown => Verdict::Unknown,
            Ok(()) => Verdict::Holds,
        },
    )
}

/// One pass, inside the room's transaction: releases past their hour ended, then this release's state, every fact,
/// core's recheck, and, if it doesn't hold, the release failed with core's reason ([`release_commit::fail`]). A release
/// that has ended, or isn't at a step the job owns, is left exactly as it is. `standing_unknown` when nothing failed
/// and a fact that matters couldn't be read. Answers `{ release_id, state, rechecked, reason }`.
pub(super) fn pass(sql: &SqlStorage, release_id: &str, reads: &Reads, now: i64) -> R<Value> {
    release_commit::end_stale(sql, now)?;
    let release = release_row(sql, release_id)?.ok_or_else(ApiError::not_found)?;
    let state = state_of(&release)?;
    if !job_owns(state) {
        return Ok(answer(&release, false, None));
    }
    match judge(sql, &release, reads, now)? {
        Verdict::Holds => Ok(answer(&release, true, None)),
        Verdict::Unknown => Err(standing_unknown()),
        Verdict::Fails(reason) => {
            release_commit::fail(sql, release_id, reason, None, now)?;
            let after = release_row(sql, release_id)?.ok_or_else(ApiError::not_found)?;
            Ok(answer(&after, true, Some(reason)))
        }
    }
}

/// `{ release_id, state, rechecked, reason }`, from the release's row. A release that has failed answers with the
/// reason on its row, whichever command ended it and whenever.
pub(super) fn answer(release: &Value, rechecked: bool, reason: Option<&str>) -> Value {
    let reason = reason.map_or_else(|| release["failure_code"].clone(), Value::from);
    json!({ "release_id": release["id"], "state": release["state"], "rechecked": rechecked, "reason": reason })
}

impl Workspace {
    /// Asks one person's own `Principal` whether they have left the organization their place in this room is held in,
    /// since that place began. Nobody is asked about someone the room's rows don't record, about an agent, or, with
    /// `authority_only`, about a person who isn't the room's owner or an admin: none of them holds, whatever a
    /// `Principal` would say. An answer that isn't a clear yes or no is no answer: `holds` is `None`.
    async fn still_holds(&self, who: Option<&str>, authority_only: bool) -> R<Asked> {
        let Some(who) = who else {
            return Ok(Asked {
                who: None,
                asked: false,
                place: None,
                holds: Some(false),
            });
        };
        let sql = self.state.storage().sql();
        let record = worth_asking(&sql, who, authority_only)?;
        let asked = record.is_some();
        let holds = match &record {
            Some(record) => principal::departed_since(&self.env, who, &record.org, record.since)
                .await
                .ok()
                .map(|departed| !departed),
            None => Some(false),
        };
        Ok(Asked {
            who: Some(who.to_owned()),
            asked,
            place: record.map(|record| (record.org, record.since)),
            holds,
        })
    }

    /// Everything a pass asks outside the room. `not_found` for a release the room doesn't have. **A fact that
    /// couldn't be read is `None`, and the rest are still read:** one object that is down never hides what another
    /// said.
    pub(super) async fn release_reads(&self, release_id: &str) -> R<Reads> {
        let sql = self.state.storage().sql();
        let read_at = release_now(&sql);
        let people = people(&sql, release_id, read_at)?.ok_or_else(ApiError::not_found)?;
        let org = room_owner_org(&sql)?;
        // The delegation is held for a provider, and the room's linked repository says which. With none linked there
        // is no provider to name: nothing is asked, and the room's own rows fail the release for having no repository.
        let provider = linked_provider(&sql)?;
        // **The order.** The stop is asked first: the applier asks it again before every write, so its answer here may
        // be the oldest. The facts nothing asks again are asked last, so their answers are as fresh as this can
        // make them at the transaction: each person's record, and last the organization's delegation.
        let stopped = match content_stop::read_from(&self.env).await {
            Stop::Clear => Some(false),
            Stop::Stopped => Some(true),
            Stop::Unreadable => None,
        };
        let deployment_on = Some(crate::releases::switched_on(&self.env).await);
        let approver = self.still_holds(people.approver.as_deref(), true).await?;
        let requester = self.still_holds(Some(&people.requester), false).await?;
        let giver = self.still_holds(people.giver.as_deref(), true).await?;
        let org_may_release = match &provider {
            Some(provider) => {
                let delegation = principal::org_delegation(&self.env, &org, provider)
                    .await
                    .ok();
                // Test builds only: a test gives the answer the organization's object is taken to have given, to
                // show an answer that isn't a yes or a no decides nothing.
                #[cfg(feature = "failpoints")]
                let delegation = match rows(
                    &sql,
                    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_release_delegation_answer'",
                    vec![],
                )?
                .is_empty()
                {
                    true => delegation,
                    false => rows(&sql, "SELECT answer FROM test_release_delegation_answer", vec![])?
                        .first()
                        .and_then(|row| row["answer"].as_str())
                        .and_then(|answer| serde_json::from_str::<Value>(answer).ok()),
                };
                // An organization with no record of its own holds the delegation: that is M5's default, restated
                // by the organization's object, which answers `granted: true` for one. Anything but a yes or a no
                // is no answer.
                delegation.and_then(|answer| answer["granted"].as_bool())
            }
            None => Some(true),
        };
        Ok(Reads {
            read_at,
            deployment_on,
            stopped,
            org,
            provider,
            org_may_release,
            approver,
            requester,
            giver,
        })
    }

    /// The release a command names, and its state as it is before anything is asked of anyone: a release that has
    /// ended, or isn't the job's, is answered as such with no outside read at all.
    pub(super) async fn named_release(&self, req: &mut Request) -> R<(String, Value)> {
        let sql = self.state.storage().sql();
        if !store::is_initialized(&sql)? {
            return Err(ApiError::not_found());
        }
        self.migrate_if_needed()?;
        self.release_path_open().await?;
        let body: Value =
            serde_json::from_str(&req.text().await?).map_err(|_| ApiError::invalid_argument())?;
        let release_id = body["release_id"]
            .as_str()
            .filter(|id| is_release_id(id))
            .ok_or_else(ApiError::invalid_argument)?
            .to_owned();
        let release = release_row(&sql, &release_id)?.ok_or_else(ApiError::not_found)?;
        Ok((release_id, release))
    }

    /// **The gate on the release path** (`release_commit::RELEASE_PATH_COMPLETE`). Until the path is complete, a
    /// deployment that has release switched on and a provider configured refuses every release command, exactly as a
    /// route that isn't built, and says so in one log line by its code. With either missing nothing can be served,
    /// which is every deployment today, and the commands answer.
    async fn release_path_open(&self) -> R<()> {
        if release_commit::RELEASE_PATH_COMPLETE {
            return Ok(());
        }
        let sql = self.state.storage().sql();
        if takedown::provider(&self.env, &sql).is_some()
            && crate::releases::switched_on(&self.env).await
        {
            let room = rows(&sql, "SELECT id FROM workspace", vec![])?
                .first()
                .and_then(|row| text(&row["id"]))
                .unwrap_or_default();
            console_error!(
                "release: a release command was refused: room={} code=release_path_incomplete",
                room
            );
            return Err(crate::releases::release_not_available());
        }
        Ok(())
    }

    /// Test builds only: a test changes the room between what was read outside and the transaction, at exactly this
    /// point, by leaving statements for the room to run here. And a test holds the command here, by a table it makes,
    /// `test_release_hold`: the room marks that it has arrived and waits until the table is gone, so the test can
    /// change a fact in another object at exactly this point, through that object's own commands.
    #[cfg(feature = "failpoints")]
    pub(super) async fn test_between_reads(&self) -> R<()> {
        let sql = self.state.storage().sql();
        if !rows(
            &sql,
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_release_between_reads'",
            vec![],
        )?
        .is_empty()
        {
            for row in rows(
                &sql,
                "SELECT statement FROM test_release_between_reads ORDER BY rowid",
                vec![],
            )? {
                exec(&sql, row["statement"].as_str().unwrap_or_default(), vec![])?;
            }
            exec(&sql, "DROP TABLE test_release_between_reads", vec![])?;
        }
        let held = |sql: &SqlStorage| -> R<bool> {
            Ok(!rows(
                sql,
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_release_hold'",
                vec![],
            )?
            .is_empty())
        };
        if held(&sql)? {
            exec(&sql, "UPDATE test_release_hold SET arrived = 1", vec![])?;
            // At most 20 seconds, so a test that forgets to let go fails and doesn't hang.
            for _ in 0..4000 {
                if !held(&sql)? {
                    break;
                }
                worker::Delay::from(std::time::Duration::from_millis(5)).await;
            }
        }
        Ok(())
    }

    /// Runs one release command's transaction, arms the room's alarm, and answers what the transaction did.
    pub(super) async fn release_transaction(
        &self,
        run: impl FnOnce(&SqlStorage) -> R<Value> + 'static,
    ) -> R<Value> {
        let out: Rc<RefCell<Option<Value>>> = Rc::new(RefCell::new(None));
        let slot = out.clone();
        let store = self.state.storage().sql();
        transaction_sync(&self.state, move || {
            *slot.borrow_mut() = Some(run(&store)?);
            Ok(())
        })?;
        self.arm(false, false).await?;
        let answer = out.borrow_mut().take();
        answer.ok_or_else(|| ApiError::internal("a release command answered nothing"))
    }

    /// `{ release_id }`: one pass of the recheck for one release (M6 step 5). Nothing calls it yet: the release job
    /// will, before each thing it does.
    ///
    /// **What is read first, and why.** The release's own state, from the room, before anything is asked of anyone:
    /// one that has ended, or isn't the job's, answers as such at once. Then every outside fact, none of them stopping
    /// the others. Then the room's transaction, where a fact that was read and fails ends the release whatever
    /// couldn't be read; only when nothing fails does an unread fact make the pass undecided.
    pub(super) async fn release_recheck(&self, mut req: Request) -> R<Value> {
        let (release_id, release) = self.named_release(&mut req).await?;
        if !job_owns(state_of(&release)?) {
            return Ok(answer(&release, false, None));
        }
        let reads = self.release_reads(&release_id).await?;
        #[cfg(feature = "failpoints")]
        self.test_between_reads().await?;
        self.release_transaction(move |sql| pass(sql, &release_id, &reads, release_now(sql)))
            .await
    }
}
