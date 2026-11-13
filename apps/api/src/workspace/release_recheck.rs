//! The room's recheck of a release (M6 step 5, first PR; ADR 0010's "The release job", step 1).
//!
//! "Rerun policy and recheck authority, on every pass, in the room's transaction, against current state": a job that
//! passed once doesn't keep its permission. This is that recheck and nothing else. It gathers every fact
//! `podster_core::release::recheck` asks for, from current state, runs it, and **fails the release when it doesn't
//! hold,** with core's own reason. It starts no upload and commits nothing live: those come on top of it.
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
//!   the room reads who they are now, and if any differs from who was asked about, nothing is decided: the answer is
//!   `standing_unknown`, and the next pass asks again.
//!
//! **A fact that couldn't be read is undecided, never failed.** Only a fact that was read and doesn't hold fails a
//! release, which can't be undone. The stop unreadable, an organization's or a person's record that doesn't answer,
//! an answer that isn't the shape expected, and someone the rows make worth asking about now who wasn't when the
//! questions were asked, as when they were made an admin in between: each answers `standing_unknown`, which the job
//! retries, and writes nothing.
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
//! **`organization_may_release` is the organization's provisioning delegation** (ruled by the architect on
//! 2026-11-13, for the owner to review): an operator who takes that back also stops that organization's releases.
//!
//! Logs carry the room's and the release's IDs and codes.
use super::*;
use crate::content_stop::{self, Stop};
use podster_core::release::{
    is_release_id, next_state, recheck, CommitRecord, Recheck, ReleaseEvent, ReleaseState,
    RoomReleaseFacts,
};
use podster_policy::release::{
    authorize_approval, delegation_holder, may_release_now, DeployGrant, ReleaseRoom,
    ReleaseStanding, DEPLOY_ACTION,
};

/// The room's path for one pass of the recheck. Nothing outside the Worker reaches it, and nothing calls it yet.
pub(crate) const INTERNAL_RELEASE_RECHECK: &str = "/internal/release-recheck";

fn standing_unknown() -> ApiError {
    ApiError::api(503, "standing_unknown")
}

/// One question asked of someone's own `Principal` before the room's transaction: who it was about, and whether they
/// still hold. `who` is `None` when there was nobody to ask about. `asked` is whether their `Principal` was asked at
/// all: nobody is asked about someone the room's rows didn't make worth asking about, and then `holds` is false.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Asked {
    who: Option<String>,
    asked: bool,
    holds: bool,
}

/// Everything the recheck learns outside the room, before its transaction. Never taken from a request.
pub(super) struct Reads {
    deployment_on: bool,
    /// The stop, as the `Moderation` object said it. One that couldn't be read never gets this far.
    stopped: bool,
    /// The organization the delegation was read for, the provider it was read for, and whether the organization
    /// holds it. With no repository linked there is no provider to ask about, and nothing was asked.
    org: String,
    provider: Option<String>,
    org_may_release: bool,
    approver: Asked,
    requester: Asked,
    giver: Asked,
}

/// The requester's live `deploy` grant on the room's linked repository, as the room's row has it. A grant on any other
/// repository isn't looked at: with no repository linked, there is none.
struct GrantRow {
    provider_repo_id: i64,
    delegated_by: String,
    expires_at: Option<i64>,
}

fn deploy_grant(sql: &SqlStorage, principal: &str) -> R<Option<GrantRow>> {
    Ok(rows(
        sql,
        "SELECT provider_repo_id, delegated_by, expires_at FROM provider_grant
           WHERE principal_id = ? AND action = ? AND revoked_at IS NULL
             AND provider_repo_id = (SELECT provider_repo_id FROM repo_link) ORDER BY created_at, id LIMIT 1",
        vec![principal.into(), DEPLOY_ACTION.into()],
    )?
    .first()
    .and_then(|row| {
        Some(GrantRow {
            provider_repo_id: int(&row["provider_repo_id"]),
            delegated_by: text(&row["delegated_by"])?,
            expires_at: row["expires_at"].as_i64(),
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

fn people(sql: &SqlStorage, release: &str) -> R<Option<People>> {
    let found = rows(
        sql,
        "SELECT requested_by, approved_by FROM release WHERE id = ?",
        vec![release.into()],
    )?;
    let Some(row) = found.first() else {
        return Ok(None);
    };
    let requester = text(&row["requested_by"]).unwrap_or_default();
    let giver = deploy_grant(sql, &requester)?.map(|grant| grant.delegated_by);
    Ok(Some(People {
        approver: text(&row["approved_by"]),
        requester,
        giver,
    }))
}

/// What the room and the others say of whether release may happen here at all, for policy and for core alike.
fn room_facts(sql: &SqlStorage, reads: &Reads) -> R<RoomReleaseFacts> {
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
        deployment_allows_release: reads.deployment_on,
        archived: status == ARCHIVED,
        // Nothing deletes a room yet. A status that is neither of the two there are would be one that had been.
        deleted: status != ACTIVE_ROOM && status != ARCHIVED,
        public: room["visibility"].as_str() == Some("public"),
        // Nothing deletes an organization yet.
        organization_exists: true,
        public_surface_suspended: !room["suspended_at"].is_null(),
        app_suspended: takedown::app_suspended(sql)?,
        organization_may_release: reads.org_may_release,
        repository_ready,
        // Set by the caller, from the requester's own standing: see `gather`.
        someone_may_release: false,
    })
}

/// One recheck's inputs as core takes them, with the strings it borrows.
struct Gathered {
    room: RoomReleaseFacts,
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

/// Gathers every fact, inside the room's transaction, from the room's rows now and what was read outside. `Err` with
/// `standing_unknown` when what was read outside isn't about who the rows name now.
fn gather(sql: &SqlStorage, release: &Value, reads: &Reads, now: i64) -> R<Gathered> {
    let id = release["id"].as_str().unwrap_or_default();
    let People {
        approver,
        requester,
        giver,
    } = people(sql, id)?.ok_or_else(ApiError::not_found)?;
    // Each answer from outside is about someone. If the rows name someone else now, it answers nothing.
    if reads.approver.who != approver
        || reads.requester.who.as_deref() != Some(requester.as_str())
        || reads.giver.who != giver
        || reads.org != room_owner_org(sql)?
        || reads.provider != linked_provider(sql)?
    {
        return Err(standing_unknown());
    }
    // And each must have been asked, if the rows make them worth asking about now. Someone made an admin, or added
    // to the room, since the questions were asked wasn't: what is known of them is nothing, which is undecided.
    for (answer, authority_only) in [
        (&reads.approver, true),
        (&reads.requester, false),
        (&reads.giver, true),
    ] {
        if let Some(who) = &answer.who {
            if !answer.asked && worth_asking(sql, who, authority_only)?.is_some() {
                return Err(standing_unknown());
            }
        }
    }
    let mut room = room_facts(sql, reads)?;
    let link_repo_id = rows(sql, "SELECT provider_repo_id FROM repo_link", vec![])?
        .first()
        .map_or(0, |link| int(&link["provider_repo_id"]));
    let release_room = ReleaseRoom {
        deployment_allows_release: room.deployment_allows_release,
        organization_may_release: room.organization_may_release,
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
    let grant = deploy_grant(sql, &requester)?;
    let holder = match (&grant, &giver) {
        (Some(_), Some(giver)) => repositories::recorded_giver(sql, giver)?
            .and_then(|g| delegation_holder(giver, g.kind, g.role, reads.giver.holds)),
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
        && reads.requester.holds;
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
            authorize_approval(&caller, reads.approver.holds, &release_room).is_ok()
        }
        None => false,
    };

    // The commit, by the room's own merge record for the release's task: Podster's merge job merged it and read it
    // back, in the repository that record names, and the task is completed.
    //
    // "Merged by Podster" is two things in that record, and they suffice. `succeeded` is written in one place only,
    // by Podster's merge job, on core's proof that it read the pull request back as merged with the default branch
    // holding the reviewed commit. `merge_called_at` says that job itself called the merge: a merge someone else
    // made is recorded by the watcher with neither. `merged_by_id` is who the provider says merged, and the room
    // keeps no ID of the merge App's own account to compare it with, so it adds nothing here.
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
    Ok(Gathered {
        room,
        domain_stopped: reads.stopped,
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
    })
}

/// One pass, inside the room's transaction: the release's state, every fact, core's recheck, and, if it doesn't hold,
/// the release failed with core's reason, audited and told to the room's managers. A release that has ended, or isn't
/// at a step the job owns, is left exactly as it is. Answers `{ release_id, state, rechecked, reason }`.
pub(super) fn pass(sql: &SqlStorage, release_id: &str, reads: &Reads, now: i64) -> R<Value> {
    let found = rows(
        sql,
        "SELECT id, state, task_id, commit_sha, config_version, release_epoch FROM release WHERE id = ?",
        vec![release_id.into()],
    )?;
    let release = found.first().ok_or_else(ApiError::not_found)?;
    let state = release["state"]
        .as_str()
        .and_then(|name| ReleaseState::ALL.into_iter().find(|s| s.name() == name))
        .ok_or_else(|| ApiError::internal("a release in no state"))?;
    let unchanged = |rechecked: bool| json!({ "release_id": release_id, "state": state.name(), "rechecked": rechecked, "reason": Value::Null });
    // The job owns a release once it is approved and until the room has committed it live. Before that there is no
    // approver to ask about. After it, ending the release also means setting hosts back, which isn't this command's.
    if !matches!(
        state,
        ReleaseState::Queued | ReleaseState::Uploading | ReleaseState::Uncertain
    ) {
        return Ok(unchanged(false));
    }
    let facts = gather(sql, release, reads, now)?;
    let commit = facts.commit.as_ref().map(|c| CommitRecord {
        sha: &c.0,
        provider_repo_id: c.1,
        merged_by_podster: c.2,
        confirmed_on_default_branch: c.3,
        task_completed: c.4,
    });
    let failure = match recheck(&Recheck {
        room: facts.room,
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
        Ok(()) => return Ok(unchanged(true)),
        Err(failure) => failure,
    };
    let failed = next_state(state, ReleaseEvent::Fail)
        .map_err(|_| ApiError::internal("a release the job owns that can't fail"))?;
    let reason = failure.code();
    exec(
        sql,
        "UPDATE release SET state = ?, failure_code = ?, finished_at = ?, updated_at = ? WHERE id = ?",
        vec![
            failed.name().into(),
            reason.into(),
            now.into(),
            now.into(),
            release_id.into(),
        ],
    )?;
    audit_as(
        sql,
        moderation::PODSTER,
        moderation::PODSTER_KIND,
        "release.failed",
        release_id,
        Some(json!({ "state": state.name() }).to_string()),
        Some(json!({ "state": failed.name(), "reason": reason }).to_string()),
        now,
    )?;
    // The event names the release it is about, by its ID, and the reason, by its code.
    store::record_event_about(
        sql,
        "release.failed",
        moderation::PODSTER,
        Some(release_id),
        None,
        &Transition {
            reason: Some(reason),
            ..Transition::NONE
        },
        roles::room_managers(sql, moderation::PODSTER)?,
        now,
    )?;
    Ok(
        json!({ "release_id": release_id, "state": failed.name(), "rechecked": true, "reason": reason }),
    )
}

impl Workspace {
    /// Asks one person's own `Principal` whether they have left the organization their place in this room is held in,
    /// since that place began. Nobody is asked about someone the room's rows don't record, about an agent, or, with
    /// `authority_only`, about a person who isn't the room's owner or an admin: none of them holds, whatever a
    /// `Principal` would say. An answer that isn't a clear yes or no is `standing_unknown`.
    async fn still_holds(&self, who: Option<&str>, authority_only: bool) -> R<Asked> {
        let Some(who) = who else {
            return Ok(Asked {
                who: None,
                asked: false,
                holds: false,
            });
        };
        let sql = self.state.storage().sql();
        let record = worth_asking(&sql, who, authority_only)?;
        let asked = record.is_some();
        let holds = match record {
            Some(record) => !principal::departed_since(&self.env, who, &record.org, record.since)
                .await
                .map_err(|_| standing_unknown())?,
            None => false,
        };
        Ok(Asked {
            who: Some(who.to_owned()),
            asked,
            holds,
        })
    }

    /// Everything a pass asks outside the room, before its transaction. `not_found` for a release the room doesn't
    /// have; `standing_unknown` if an organization or a person couldn't answer.
    pub(super) async fn release_reads(&self, release_id: &str) -> R<Reads> {
        let sql = self.state.storage().sql();
        let people = people(&sql, release_id)?.ok_or_else(ApiError::not_found)?;
        let org = room_owner_org(&sql)?;
        // The delegation is held for a provider, and the room's linked repository says which. With none linked there
        // is no provider to name: nothing is asked, and the room's own rows fail the release for having no repository.
        let provider = linked_provider(&sql)?;
        let org_may_release = match &provider {
            Some(provider) => {
                let delegation = principal::org_delegation(&self.env, &org, provider)
                    .await
                    .map_err(|_| standing_unknown());
                // Test builds only: a test gives the answer the organization's object is taken to have given, to
                // show an answer that can't be read, or isn't a yes or a no, decides nothing.
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
                        .and_then(|answer| serde_json::from_str::<Value>(answer).ok())
                        .ok_or_else(standing_unknown),
                };
                // An organization with no record of its own holds the delegation: that is M5's default, restated
                // by the organization's object, which answers `granted: true` for one. Anything but a yes or a no
                // is no answer.
                delegation?["granted"]
                    .as_bool()
                    .ok_or_else(standing_unknown)?
            }
            None => true,
        };
        // The stop that can't be read is undecided: the pass is refused and retried, and nothing is written.
        let stopped = match content_stop::read_from(&self.env).await {
            Stop::Clear => false,
            Stop::Stopped => true,
            Stop::Unreadable => return Err(standing_unknown()),
        };
        Ok(Reads {
            deployment_on: crate::releases::switched_on(&self.env).await,
            stopped,
            org,
            provider,
            org_may_release,
            approver: self.still_holds(people.approver.as_deref(), true).await?,
            requester: self.still_holds(Some(&people.requester), false).await?,
            giver: self.still_holds(people.giver.as_deref(), true).await?,
        })
    }

    /// `{ release_id }`: one pass of the recheck for one release (M6 step 5). Nothing calls it yet: the release job
    /// will, before each thing it does.
    pub(super) async fn release_recheck(&self, mut req: Request) -> R<Value> {
        let sql = self.state.storage().sql();
        if !store::is_initialized(&sql)? {
            return Err(ApiError::not_found());
        }
        self.migrate_if_needed()?;
        let body: Value =
            serde_json::from_str(&req.text().await?).map_err(|_| ApiError::invalid_argument())?;
        let release_id = body["release_id"]
            .as_str()
            .filter(|id| is_release_id(id))
            .ok_or_else(ApiError::invalid_argument)?
            .to_owned();
        let reads = self.release_reads(&release_id).await?;
        // Test builds only: a test changes the room between what was read outside and the transaction, at exactly
        // this point, by leaving statements for the room to run here.
        #[cfg(feature = "failpoints")]
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
        let out: Rc<RefCell<Option<Value>>> = Rc::new(RefCell::new(None));
        let slot = out.clone();
        let store = sql.clone();
        transaction_sync(&self.state, move || {
            *slot.borrow_mut() = Some(pass(&store, &release_id, &reads, now_ms())?);
            Ok(())
        })?;
        self.arm(false, false).await?;
        let answer = out.borrow_mut().take();
        answer.ok_or_else(|| ApiError::internal("release recheck answered nothing"))
    }
}
