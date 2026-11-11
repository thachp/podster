//! Managed repositories: the room's state for M5 (ADR 0009, which is proposed), as far as step 2 goes.
//!
//! The room owns five tables: `repo_request` and its `repo_request_attempt`s, `repo_link`, `provider_grant` and
//! `task_change`. Nothing writes them yet: provisioning is step 4. This module only reads the request and the link, for a
//! person. `get_repo_access`, `merge_task` and `get_task_release_status` have no route here. Each arrives with the step
//! that builds it, so no agent sees a merge tool before the merge path and its checks exist (AC-17).
//!
//! Step 5 adds the room's side of a provider's webhook delivery: `nudge`, and the room's one row in the routing lookup.
use super::*;
use podster_core::provider_deliveries::{
    decide, is_well_formed, Arrival, EventKind, Nudge, NudgeOutcome, DELIVERY_RETENTION_MS,
};
use podster_core::repo_grants::{
    decide_grant, decide_revoke, grants_ended_by_ownership_change, grants_ended_by_removal, Grant,
    GrantPlan, GrantRefusal, RevokePlan,
};
use podster_core::repositories::GrantAction;
use podster_policy::repositories::{
    authorize_grant, authorize_repository_request, authorize_revoke, delegation_holder,
    holds_repository_delegation, may_receive_grant, sees_grant, RepoDenial,
};

/// `GET repository`: the room's request for a repository and its linked repository, each null if there's none. For
/// a person who sees the whole room, never an agent: the contract lists it as person-only, and an agent will learn of the
/// repository through `get_repo_access`, once step 6 builds it. It's a read of current state and authorizes nothing.
///
/// `may_request` says whether the caller could ask for the repository or retry its setup as far as who they are goes:
/// a person who is the room's owner or a room admin, whom this deployment lets ask. It's for a screen to show the
/// option or say it's unavailable, and the commands decide again for themselves.
pub(super) fn read(
    sql: &SqlStorage,
    who: &Participant,
    requesters: &podster_core::provisioning::RepositoryRequesters,
) -> R<Value> {
    if who.caller.kind != PrincipalKind::Person || !sees_whole_room(&who.caller) {
        return Err(ApiError::not_allowed());
    }
    let request = rows(sql, "SELECT id, state, name, visibility, reason, requested_by, requested_at, updated_at, runs FROM repo_request", vec![])?
        .first()
        .map_or(Value::Null, |r| json!({
            "id": r["id"], "state": r["state"], "name": r["name"], "visibility": r["visibility"], "reason": r["reason"],
            "requested_by": r["requested_by"], "requested_at": r["requested_at"], "updated_at": r["updated_at"],
            "attempts_left": super::provisioning::attempts_left(int(&r["runs"])),
        }));
    let repository = rows(sql, "SELECT id, provider, provider_repo_id, full_name, visibility, default_branch, status, status_reason, created_at, verified_at, updated_at FROM repo_link", vec![])?
        .first()
        .map_or(Value::Null, |r| json!({
            "id": r["id"], "provider": r["provider"], "provider_repo_id": r["provider_repo_id"], "full_name": r["full_name"],
            "visibility": r["visibility"], "default_branch": r["default_branch"], "status": r["status"],
            "status_reason": r["status_reason"], "created_at": r["created_at"], "verified_at": r["verified_at"],
            "updated_at": r["updated_at"],
        }));
    let may_request = authorize_repository_request(&who.caller, requesters).is_ok();
    Ok(json!({ "request": request, "repository": repository, "may_request": may_request }))
}

/// The Worker's call for a provider's webhook delivery. Reached only from `crate::provider`, which has verified the
/// gateway's assertion for it.
pub(super) const INTERNAL_PROVIDER_DELIVERY: &str = crate::provider::INTERNAL_PROVIDER_DELIVERY;

/// One webhook delivery, as a nudge (M5 step 5). `{ delivery_id, body_sha256, event, repository_id, pull_requests,
/// head_sha }`, in the caller's transaction.
///
/// The room's own link decides whose repository this is, never the lookup that routed it here. A delivery is taken once:
/// by its ID, and by the hash of the body the provider signed, since the signature doesn't cover the ID and one captured
/// body could come again under any number of new ones. A delivery that names a pull request or a commit of a task's change
/// marks that change as nudged, with the time, and that's all it does. One about anything else leaves nothing behind. It
/// records no head, check, merge or pull request state, because a delivery's word for those is never taken: what the room
/// knows about a change comes from Podster's own read of the provider, which steps 6 to 8 build, and `nudged_at` is what
/// tells them a read is due.
///
/// This is bookkeeping, not a command (ruled by the architect, 2026-11-10): a mark that a read is due, which no
/// participant sees, like `indexed_at`. So it writes no event, outbox row or idempotency record. The read that follows is
/// a command, and commits what it observed with its event and outbox.
pub(super) fn nudge(sql: &SqlStorage, body: &Value, now: i64) -> R<Value> {
    let delivery = Nudge {
        delivery_id: body["delivery_id"].as_str().unwrap_or_default().to_string(),
        body_sha256: body["body_sha256"].as_str().unwrap_or_default().to_string(),
        event: body["event"]
            .as_str()
            .and_then(EventKind::from_name)
            .ok_or_else(ApiError::invalid_argument)?,
        repository_id: body["repository_id"].as_i64().unwrap_or(0),
        pull_requests: body["pull_requests"]
            .as_array()
            .map(|numbers| numbers.iter().filter_map(Value::as_i64).collect())
            .unwrap_or_default(),
        head_sha: text(&body["head_sha"]),
    };
    if !is_well_formed(&delivery) {
        return Err(ApiError::invalid_argument());
    }
    let linked = rows(
        sql,
        "SELECT provider_repo_id FROM repo_link WHERE provider = 'github'",
        vec![],
    )?
    .first()
    .map(|link| int(&link["provider_repo_id"]));
    // Old ones go first, so they don't count against what the room holds. Only for the room's own repository: a delivery
    // for any other writes nothing at all.
    if linked == Some(delivery.repository_id) {
        prune_deliveries(sql, now)?;
    }
    let seen_before = !rows(
        sql,
        "SELECT 1 AS seen FROM provider_delivery WHERE delivery_id = ? OR body_sha256 = ? LIMIT 1",
        vec![
            delivery.delivery_id.as_str().into(),
            delivery.body_sha256.as_str().into(),
        ],
    )?
    .is_empty();
    let held = rows(sql, "SELECT count(*) AS n FROM provider_delivery", vec![])?
        .first()
        .map_or(0, |row| int(&row["n"]));
    // By pull request number, or by a commit the room already holds for a change. Both only pick which change to read again.
    let mut known: Vec<String> = vec![];
    for number in &delivery.pull_requests {
        known.extend(
            rows(
                sql,
                "SELECT task_id FROM task_change WHERE provider_repo_id = ? AND pr_number = ?",
                vec![delivery.repository_id.into(), (*number).into()],
            )?
            .iter()
            .filter_map(|row| text(&row["task_id"])),
        );
    }
    if let Some(sha) = &delivery.head_sha {
        known.extend(
            rows(
                sql,
                "SELECT task_id FROM task_change WHERE provider_repo_id = ? AND (observed_head_sha = ? OR reviewed_commit_sha = ?)",
                vec![delivery.repository_id.into(), sha.as_str().into(), sha.as_str().into()],
            )?
            .iter()
            .filter_map(|row| text(&row["task_id"])),
        );
    }
    let outcome = decide(&Arrival {
        linked_repository: linked,
        observed_repository: delivery.repository_id,
        seen_before,
        names_known_change: !known.is_empty(),
        held,
    });
    if outcome == NudgeOutcome::Nudged {
        exec(
            sql,
            "INSERT INTO provider_delivery (delivery_id, body_sha256, received_at, expires_at) VALUES (?, ?, ?, ?)",
            vec![
                delivery.delivery_id.as_str().into(),
                delivery.body_sha256.as_str().into(),
                now.into(),
                (now + DELIVERY_RETENTION_MS).into(),
            ],
        )?;
    }
    if matches!(
        outcome,
        NudgeOutcome::Nudged | NudgeOutcome::NudgedUnrecorded
    ) {
        for task in &known {
            exec(
                sql,
                // A change the refresh job gave up on, because its pull request kept answering as not there, is watched
                // again once a delivery names it (M5 step 7a).
                "UPDATE task_change SET nudged_at = ?, unwatched_at = NULL, not_found_reads = 0 WHERE task_id = ?",
                vec![now.into(), task.as_str().into()],
            )?;
        }
    }
    Ok(json!({ "outcome": outcome.code() }))
}

/// Forgets delivery IDs past their time. A replay after that costs one nudge and changes nothing else.
pub(super) fn prune_deliveries(sql: &SqlStorage, now: i64) -> R<()> {
    exec(
        sql,
        "DELETE FROM provider_delivery WHERE expires_at <= ?",
        vec![now.into()],
    )
}

/// How soon an overdue delivery ID wakes the room again, so one that can't be cleared can't spin the alarm.
const DELIVERY_REARM_MS: i64 = 1_000;

/// When the room's alarm should next forget a delivery ID, if it holds any.
pub(super) fn next_delivery_expiry(sql: &SqlStorage, now: i64) -> R<Option<i64>> {
    Ok(rows(
        sql,
        "SELECT min(expires_at) AS due FROM provider_delivery",
        vec![],
    )?
    .first()
    .and_then(|row| row["due"].as_f64())
    .map(|due| (due as i64).max(now + DELIVERY_REARM_MS)))
}

/// Whether the room's repository isn't in the routing lookup yet.
pub(super) fn index_due(sql: &SqlStorage) -> R<bool> {
    Ok(!rows(
        sql,
        "SELECT 1 AS due FROM repo_link WHERE indexed_at IS NULL",
        vec![],
    )?
    .is_empty())
}

/// The room's answer to another room that found this one holding a routing row: whether this room's link really is that
/// repository. A room that was never made, or has no link, or another repository, doesn't hold it.
pub(super) const INTERNAL_LINK_HOLDS: &str = "/internal/repo-link-holds";

pub(super) fn link_holds(sql: &SqlStorage, body: &Value) -> R<Value> {
    let asked = body["repository"].as_i64();
    let linked = rows(sql, "SELECT provider_repo_id FROM repo_link", vec![])?
        .first()
        .map(|link| int(&link["provider_repo_id"]));
    Ok(json!({ "holds": asked.is_some() && asked == linked }))
}

/// Asks the room a routing row names whether it's really linked to that repository. If it can't be asked, it's taken to
/// be, so a row is only ever taken from a room that said it isn't its own.
async fn holder_confirms(env: &Env, holder: &str, repository: i64) -> bool {
    if !crate::valid_id(holder) {
        return false;
    }
    let ask = async {
        let stub = env
            .durable_object("WORKSPACE")?
            .id_from_name(holder)?
            .get_stub()?;
        let mut answer = crate::forward(
            stub,
            INTERNAL_LINK_HOLDS,
            "",
            Headers::new(),
            Method::Post,
            Some(json!({ "repository": repository }).to_string()),
        )
        .await?;
        let body: Value = answer.json().await?;
        Ok::<_, ApiError>(body["holds"].as_bool())
    };
    !matches!(ask.await, Ok(Some(false)))
}

/// Writes the room's row in `repo_room_index`, once, after its link exists. The row routes a delivery here and authorizes
/// nothing. If another room's row is in the way, that room is asked whether the repository is really its own. A row whose
/// room says no, a stale or squatted one, is replaced. A row whose room says yes, or can't be asked, is left, and this
/// room's is marked as refused with a zero so the alarm doesn't keep trying.
pub(super) async fn drain_index(sql: &SqlStorage, db: &D1Database, env: &Env) -> R<()> {
    if !store::is_initialized(sql)? || store::needs_migration(sql)? {
        return Ok(());
    }
    let Some(link) = rows(
        sql,
        "SELECT provider, provider_repo_id FROM repo_link WHERE indexed_at IS NULL",
        vec![],
    )?
    .into_iter()
    .next() else {
        return Ok(());
    };
    let room = objects::room_id(sql)?;
    let provider = text(&link["provider"]).unwrap_or_default();
    let repository = int(&link["provider_repo_id"]);
    let key = || -> Vec<JsValue> {
        vec![
            provider.as_str().into(),
            JsValue::from_f64(repository as f64),
        ]
    };
    let mut row = key();
    row.push(room.as_str().into());
    db.prepare("INSERT INTO repo_room_index (provider, provider_repo_id, workspace_id) VALUES (?, ?, ?) ON CONFLICT (provider, provider_repo_id) DO NOTHING")
        .bind(&row)?
        .run()
        .await?;
    let holder = db
        .prepare(
            "SELECT workspace_id FROM repo_room_index WHERE provider = ? AND provider_repo_id = ?",
        )
        .bind(&key())?
        .first::<Value>(None)
        .await?;
    let holder = holder
        .as_ref()
        .and_then(|found| found["workspace_id"].as_str())
        .unwrap_or_default()
        .to_string();
    let mut ours = holder == room;
    if !ours && !holder_confirms(env, &holder, repository).await {
        // Only if it's still that room's row: another room may have taken it meanwhile.
        let mut swap = key();
        swap.insert(0, room.as_str().into());
        swap.push(holder.as_str().into());
        let replaced = db
            .prepare("UPDATE repo_room_index SET workspace_id = ? WHERE provider = ? AND provider_repo_id = ? AND workspace_id = ?")
            .bind(&swap)?
            .run()
            .await?;
        ours = replaced
            .meta()?
            .and_then(|meta| meta.changes)
            .is_some_and(|changes| changes > 0);
        console_log!(
            "{}",
            json!({ "at": "repo_index.replaced_stale_row", "room": room, "repository": repository, "replaced": ours })
        );
    }
    if !ours {
        console_error!(
            "{}",
            json!({ "at": "repo_index.held_by_another_room", "room": room, "repository": repository })
        );
    }
    exec(
        sql,
        "UPDATE repo_link SET indexed_at = ? WHERE provider_repo_id = ? AND indexed_at IS NULL",
        vec![if ours { now_ms() } else { 0 }.into(), repository.into()],
    )
}

impl Workspace {
    /// Another room asking whether this one is linked to a repository. A room that was never made stays empty.
    pub(super) async fn answer_link_holds(&self, mut req: Request) -> R<Value> {
        let sql = self.state.storage().sql();
        if !store::is_initialized(&sql)? {
            return Ok(json!({ "holds": false }));
        }
        self.migrate_if_needed()?;
        let body: Value =
            serde_json::from_str(&req.text().await?).map_err(|_| ApiError::invalid_argument())?;
        link_holds(&sql, &body)
    }

    /// A provider's delivery, in a transaction of its own. An unknown room answers as one that isn't this repository's.
    pub(super) async fn provider_delivery(&self, mut req: Request) -> R<Value> {
        let sql = self.state.storage().sql();
        if !store::is_initialized(&sql)? {
            return Ok(json!({ "outcome": NudgeOutcome::NotThisRoom.code() }));
        }
        self.migrate_if_needed()?;
        let body: Value =
            serde_json::from_str(&req.text().await?).map_err(|_| ApiError::invalid_argument())?;
        let out: Rc<RefCell<Option<Value>>> = Rc::new(RefCell::new(None));
        let slot = out.clone();
        let store = sql.clone();
        transaction_sync(&self.state, move || {
            *slot.borrow_mut() = Some(nudge(&store, &body, now_ms())?);
            Ok(())
        })?;
        let answer = out.borrow_mut().take();
        answer.ok_or_else(|| ApiError::internal("delivery answered nothing"))
    }

    /// The alarm's part for repositories: the routing row, and delivery IDs past their time. Neither failing holds up the other.
    pub(super) async fn repository_upkeep(&self, sql: &SqlStorage) -> R<()> {
        if !store::is_initialized(sql)? || store::needs_migration(sql)? {
            return Ok(());
        }
        let pruning = sql.clone();
        if let Err(error) =
            transaction_sync(&self.state, move || prune_deliveries(&pruning, now_ms()))
        {
            console_error!("couldn't forget old deliveries: {:?}", error.code());
        }
        let written = match self.env.d1("DB") {
            Ok(db) => drain_index(sql, &db, &self.env).await,
            Err(error) => Err(error.into()),
        };
        if let Err(error) = &written {
            // The code only. An internal error's message can carry D1's text.
            console_error!(
                "repository index failed: code={}",
                error.code().unwrap_or("internal_error")
            );
        }
        written
    }
}

// ---- Grants on the room's repository (M5 step 5b) ----
//
// Giving and taking back a `push` or `merge` grant, the room's list of grants, and the two places other commands end them.
// Each command runs `podster_policy::repositories` first, then `podster_core::repo_grants`, and writes the row, its audit
// entry and its event in the caller's transaction, which `Workspace::command` commits with the idempotency record. A
// grant authorizes nothing here: tokens and merges are steps 6 and 7, and they check the grant again at every use. Logs
// carry nothing from these, and audit entries and events carry IDs and fixed codes only.

/// How far ahead a grant's expiry may be: one year (ruled by the architect, 2026-11-10).
const MAX_GRANT_LIFETIME_MS: i64 = 365 * 24 * 60 * 60 * 1000;

const GRANT_COLUMNS: &str =
    "id, principal_id, provider_repo_id, action, delegated_by, created_at, expires_at, revoked_at";

/// One `provider_grant` row, owned.
struct GrantRow {
    id: String,
    principal: String,
    provider_repo_id: i64,
    action: GrantAction,
    delegated_by: String,
    created_at: i64,
    expires_at: Option<i64>,
    revoked_at: Option<i64>,
}

impl GrantRow {
    /// A row this code can't read, with an action it doesn't know, is left out. Nothing writes one, and it can't count:
    /// a grant counts only for the action it names.
    fn from_row(row: &Value) -> Option<GrantRow> {
        Some(GrantRow {
            id: text(&row["id"])?,
            principal: text(&row["principal_id"])?,
            provider_repo_id: row["provider_repo_id"].as_i64()?,
            action: GrantAction::from_name(row["action"].as_str()?)?,
            delegated_by: text(&row["delegated_by"])?,
            created_at: int(&row["created_at"]),
            expires_at: row["expires_at"].as_i64(),
            revoked_at: row["revoked_at"].as_i64(),
        })
    }

    fn grant(&self) -> Grant<'_> {
        Grant {
            id: &self.id,
            principal: &self.principal,
            provider_repo_id: self.provider_repo_id,
            action: self.action,
            delegated_by: &self.delegated_by,
            expires_at: self.expires_at,
            revoked_at: self.revoked_at,
        }
    }

    /// The grant as the API answers it. `state` is for showing, from the room's current rows: `live`, `expired`,
    /// `stale` when its giver is no longer the room's owner or a room admin, or `revoked`. It authorizes nothing, and it
    /// can say `live` for a grant that's already stale, when its giver has left their organization and the room hasn't
    /// been told yet. Step 6 and step 7 never read it: each runs `check_grant` with the giver's standing as it is now.
    /// `holder` is [`recorded_holder`] for this grant's giver.
    fn json(&self, holder: Option<&str>, now: i64) -> Value {
        let state = if self.revoked_at.is_some() {
            "revoked"
        } else if !self.grant().is_live(now) {
            "expired"
        } else if holder != Some(self.delegated_by.as_str()) {
            "stale"
        } else {
            "live"
        };
        json!({
            "id": self.id, "principal_id": self.principal, "action": self.action.name(), "delegated_by": self.delegated_by,
            "created_at": self.created_at, "expires_at": self.expires_at, "revoked_at": self.revoked_at, "state": state,
        })
    }
}

fn grant_rows(sql: &SqlStorage, filter: &str, bindings: Vec<V>) -> R<Vec<GrantRow>> {
    Ok(rows(
        sql,
        &format!(
            "SELECT {GRANT_COLUMNS} FROM provider_grant WHERE {filter} ORDER BY created_at, id"
        ),
        bindings,
    )?
    .iter()
    .filter_map(GrantRow::from_row)
    .collect())
}

/// What the room records now for someone who gave a grant.
pub(super) struct GiverRecord {
    pub(super) kind: PrincipalKind,
    pub(super) role: Role,
    /// The organization their role is held in, and when the membership it was given under began.
    pub(super) org: String,
    pub(super) since: i64,
}

/// The room's current rows for a grant's giver: its recorded owner, unless the room records that they left, or a member
/// row that isn't revoked. `None` for anyone else, such as someone removed.
pub(super) fn recorded_giver(sql: &SqlStorage, giver: &str) -> R<Option<GiverRecord>> {
    let room = rows(
        sql,
        "SELECT owner_person_id, owner_org_id, owner_since FROM workspace WHERE owner_left_at IS NULL",
        vec![],
    )?;
    if let Some(room) = room
        .first()
        .filter(|room| room["owner_person_id"].as_str() == Some(giver))
    {
        return Ok(text(&room["owner_org_id"]).map(|org| GiverRecord {
            kind: PrincipalKind::Person,
            role: Role::Owner,
            org,
            since: room["owner_since"].as_i64().unwrap_or(0),
        }));
    }
    Ok(rows(
        sql,
        "SELECT kind, role, org_id, added_at FROM member WHERE principal_id = ? AND revoked_at IS NULL",
        vec![giver.into()],
    )?
    .first()
    .and_then(|member| {
        Some(GiverRecord {
            kind: parse_kind(member["kind"].as_str()?),
            role: parse_role(member["role"].as_str()?),
            org: text(&member["org_id"])?,
            since: int(&member["added_at"]),
        })
    }))
}

/// A grant's giver, if the room records them as a person who is its owner or an admin now. For showing a grant's state
/// and for the rows that say a grant ended. It lags a departure that hasn't reached the room, so nothing that
/// authorizes may use it alone: a use asks the giver's `Principal` too, through [`Workspace::giver_read`].
fn recorded_holder(sql: &SqlStorage, giver: &str) -> R<Option<String>> {
    Ok(recorded_giver(sql, giver)?
        .filter(|record| holds_repository_delegation(record.kind, record.role, true))
        .map(|_| giver.to_string()))
}

/// Whether the room still records someone as a person who is its owner or an admin: for the setup job, about whoever
/// asked for the repository.
pub(super) fn still_runs_repository(sql: &SqlStorage, person: &str) -> R<bool> {
    Ok(recorded_holder(sql, person)?.is_some())
}

/// What the room learned, before its transaction, about whether a grant's giver still holds the authority they gave it
/// under. Never taken from a request.
#[derive(Clone, Debug)]
pub(super) enum GiverRead {
    /// A first look that assumes the giver's authority holds. It can only be used to refuse.
    Hopeful,
    /// Nobody was asked: there was no grant, or the room doesn't record its giver as a person who is owner or admin.
    Nobody,
    /// The giver's `Principal` said whether they've left the organization their role is held in.
    Asked { giver: String, holds: bool },
}

/// The grant's giver changed, or came to hold a role, between the read outside the transaction and the transaction: what
/// was read doesn't answer for this giver, so nothing is decided on it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct GiverChanged;

/// The grant's giver for `GrantUse::delegation_holder`, decided in the transaction from the room's current rows and
/// what the giver's `Principal` said: the giver if they're a person who is the room's owner or a room admin now, with
/// that authority still holding, and nobody otherwise.
pub(super) fn standing_giver<'a>(
    sql: &SqlStorage,
    giver: &'a str,
    read: &GiverRead,
) -> R<std::result::Result<Option<&'a str>, GiverChanged>> {
    let Some(record) = recorded_giver(sql, giver)? else {
        return Ok(Ok(None));
    };
    // Someone the room's own rows don't make an owner or admin gave nothing that counts, whatever was read.
    if !holds_repository_delegation(record.kind, record.role, true) {
        return Ok(Ok(None));
    }
    let holds = match read {
        GiverRead::Hopeful => true,
        GiverRead::Asked {
            giver: asked,
            holds,
        } if asked == giver => *holds,
        _ => return Ok(Err(GiverChanged)),
    };
    Ok(Ok(delegation_holder(
        giver,
        record.kind,
        record.role,
        holds,
    )))
}

/// Ends every grant whose giver the room no longer records as a person who is its owner or an admin, in the transaction
/// that changed a role or removed someone. `check_grant` refuses these at use anyway. This makes the rows say so, and
/// means someone made an admin again starts with nothing they gave before, as rejoining restores nothing elsewhere.
pub(super) fn end_grants_of_former_givers(
    sql: &SqlStorage,
    actor: &str,
    actor_kind: &str,
    now: i64,
) -> R<()> {
    let live = grant_rows(sql, "revoked_at IS NULL", vec![])?;
    for grant in &live {
        if recorded_holder(sql, &grant.delegated_by)?.is_none() {
            end_grant(
                sql,
                actor,
                actor_kind,
                grant,
                "giver_lost_authority",
                true,
                now,
            )?;
        }
    }
    Ok(())
}

/// The room's linked repository: its provider and the provider's repository ID.
fn linked_repo(sql: &SqlStorage) -> R<Option<(String, i64)>> {
    Ok(rows(
        sql,
        "SELECT provider, provider_repo_id FROM repo_link",
        vec![],
    )?
    .first()
    .and_then(|link| Some((text(&link["provider"])?, link["provider_repo_id"].as_i64()?))))
}

/// A refusal from the policy, as the API answers it.
pub(super) fn denied(denial: RepoDenial) -> ApiError {
    match denial {
        RepoDenial::Grant(refusal) => refused(refusal),
        RepoDenial::Hidden => ApiError::task_not_found(),
        RepoDenial::GranteeNotParticipant | RepoDenial::GranteePublic => {
            ApiError::api(400, denial.code())
        }
        _ => ApiError::api(403, denial.code()),
    }
}

/// A refusal from `repo_grants`, as the API answers it.
fn refused(refusal: GrantRefusal) -> ApiError {
    match refusal {
        GrantRefusal::RepoNotLinked => ApiError::api(409, refusal.code()),
        GrantRefusal::InvalidExpiry => ApiError::invalid_argument(),
        GrantRefusal::GrantNotFound => ApiError::api(404, refusal.code()),
        _ => ApiError::api(403, refusal.code()),
    }
}

/// Whether the caller administers the room's organization, by the gateway's assertion.
fn administers_room_org(sql: &SqlStorage, caller: &Caller, admin_orgs: &[String]) -> R<bool> {
    if caller.kind != PrincipalKind::Person {
        return Ok(false);
    }
    let org = rows(sql, "SELECT owner_org_id FROM workspace", vec![])?
        .first()
        .and_then(|room| text(&room["owner_org_id"]));
    Ok(org.is_some_and(|org| admin_orgs.contains(&org)))
}

/// Marks one grant revoked, with its audit entry and event. `reason` is a fixed code. The holder is told unless they
/// took it back themselves, or they're being removed, since a removed principal is told only of the removal.
fn end_grant(
    sql: &SqlStorage,
    actor: &str,
    actor_kind: &str,
    grant: &GrantRow,
    reason: &str,
    tell_holder: bool,
    now: i64,
) -> R<()> {
    exec(
        sql,
        "UPDATE provider_grant SET revoked_at = ?, revoked_by = ? WHERE id = ? AND revoked_at IS NULL",
        vec![now.into(), actor.into(), grant.id.as_str().into()],
    )?;
    // A token minted under it loses its authority now, and the room's alarm takes it back (M5 step 6).
    store::mark_stale_repo_tokens(sql, now)?;
    audit_as(
        sql,
        actor,
        actor_kind,
        "repo_grant.revoked",
        &grant.id,
        Some(json!({ "principal": grant.principal, "action": grant.action.name(), "reason": reason }).to_string()),
        None,
        now,
    )?;
    let recipients: Vec<String> = if tell_holder && grant.principal != actor {
        vec![grant.principal.clone()]
    } else {
        vec![]
    };
    store::record_event_about(
        sql,
        "repo_grant.revoked",
        actor,
        Some(&grant.principal),
        None,
        &Transition::NONE,
        recipients,
        now,
    )
}

/// `POST repository/grants`: `{ policy_version, principal_id, action, expires_at? }`. A person who is the room's owner or
/// a room admin, whose authority holds, gives a participant one action on the room's repository. Granting the same again changes
/// nothing; a new expiry, an expired row or an earlier owner's row is revoked and replaced in this transaction.
pub(super) fn handle_grant(sql: &SqlStorage, caller: &Caller, body: &Value, now: i64) -> R<Value> {
    // `resolve_caller` gives a role only while it stands, so the caller's role carries that check.
    authorize_grant(caller).map_err(denied)?;
    require_policy_version(sql, body)?;
    let fields = body.as_object().ok_or_else(ApiError::invalid_argument)?;
    if fields.keys().any(|k| {
        !matches!(
            k.as_str(),
            "policy_version" | "principal_id" | "action" | "expires_at"
        )
    }) {
        return Err(ApiError::invalid_argument());
    }
    let principal = required(body, "principal_id")?;
    require_id(&principal)?;
    let action = body["action"]
        .as_str()
        .and_then(GrantAction::from_name)
        .ok_or_else(ApiError::invalid_argument)?;
    // An expiry is optional. When given, it's after now and at most a year ahead; `decide_grant` checks the first again.
    let expires_at = match &body["expires_at"] {
        Value::Null => None,
        value => Some(
            value
                .as_i64()
                .filter(|at| *at > now && *at <= now.saturating_add(MAX_GRANT_LIFETIME_MS))
                .ok_or_else(ApiError::invalid_argument)?,
        ),
    };
    let role = participant(sql, &principal)?.map_or(Role::None, |(_, role)| parse_role(&role));
    may_receive_grant(
        role,
        super::public_claims::is_public_participant(sql, &principal)?,
    )
    .map_err(denied)?;

    let link = linked_repo(sql)?;
    let held = grant_rows(
        sql,
        "principal_id = ? AND action = ? AND revoked_at IS NULL",
        vec![principal.as_str().into(), action.name().into()],
    )?;
    let held = held.first();
    let plan = decide_grant(
        link.as_ref().map(|(_, id)| *id),
        held.map(GrantRow::grant).as_ref(),
        &caller.id,
        action,
        expires_at,
        now,
    )
    .map_err(refused)?;
    let holder = Some(caller.id.as_str());
    let (provider, repo_id) = link.ok_or_else(|| refused(GrantRefusal::RepoNotLinked))?;
    match (plan, held) {
        (GrantPlan::Unchanged, Some(held)) => return Ok(held.json(holder, now)),
        (GrantPlan::RevokeThenInsert, Some(held)) => {
            end_grant(
                sql,
                &caller.id,
                kind_name(caller),
                held,
                "replaced",
                false,
                now,
            )?;
        }
        _ => {}
    }
    let granted = GrantRow {
        id: format!("pgr_{}", uuid::Uuid::new_v4().simple()),
        principal,
        provider_repo_id: repo_id,
        action,
        delegated_by: caller.id.clone(),
        created_at: now,
        expires_at,
        revoked_at: None,
    };
    exec(
        sql,
        "INSERT INTO provider_grant (id, principal_id, provider, provider_repo_id, action, delegated_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        vec![
            granted.id.as_str().into(),
            granted.principal.as_str().into(),
            provider.as_str().into(),
            repo_id.into(),
            action.name().into(),
            caller.id.as_str().into(),
            now.into(),
            expires_at.map_or(V::Null, V::from),
        ],
    )?;
    audit(
        sql,
        caller,
        "repo_grant.given",
        &granted.id,
        None,
        Some(json!({ "principal": granted.principal, "action": action.name(), "expires_at": expires_at }).to_string()),
        now,
    )?;
    let recipients: Vec<String> = if granted.principal != caller.id {
        vec![granted.principal.clone()]
    } else {
        vec![]
    };
    store::record_event_about(
        sql,
        "repo_grant.given",
        &caller.id,
        Some(&granted.principal),
        None,
        &Transition::NONE,
        recipients,
        now,
    )?;
    Ok(granted.json(holder, now))
}

/// Whether a stored answer to a grant may be replayed: only to someone who may still give one.
pub(super) fn may_still_grant(caller: &Caller) -> R<()> {
    authorize_grant(caller).map_err(denied)
}

/// `DELETE repository/grants/{grant}`: `{ policy_version }`. The room's owner, a person who administers the room's
/// organization, or the grant's holder for their own. A grant the caller may not see answers `grant_not_found`, as one
/// that doesn't exist does. Taking back a grant that's already revoked changes nothing. An agent gets `not_allowed`, even
/// for its own grant: no agent route exists until step 6, and the owner or an organization's admin takes one back.
pub(super) fn handle_revoke(
    sql: &SqlStorage,
    caller: &Caller,
    admin_orgs: &[String],
    grant_id: &str,
    body: &Value,
    now: i64,
) -> R<Value> {
    let grant = revocable(sql, caller, admin_orgs, grant_id)?;
    require_policy_version(sql, body)?;
    let fields = body.as_object().ok_or_else(ApiError::invalid_argument)?;
    if fields.keys().any(|k| k != "policy_version") {
        return Err(ApiError::invalid_argument());
    }
    match decide_revoke(Some(&grant.grant())).map_err(refused)? {
        RevokePlan::Revoke => {
            end_grant(
                sql,
                &caller.id,
                kind_name(caller),
                &grant,
                "revoked",
                true,
                now,
            )?;
        }
        RevokePlan::AlreadyRevoked => {}
    }
    let after = grant_rows(sql, "id = ?", vec![grant_id.into()])?;
    let after = after
        .first()
        .ok_or_else(|| refused(GrantRefusal::GrantNotFound))?;
    Ok(after.json(recorded_holder(sql, &after.delegated_by)?.as_deref(), now))
}

/// Whether a stored answer to taking a grant back may be replayed: only to someone who may still take that grant back.
pub(super) fn may_still_revoke(
    sql: &SqlStorage,
    caller: &Caller,
    admin_orgs: &[String],
    grant_id: &str,
) -> R<()> {
    revocable(sql, caller, admin_orgs, grant_id).map(|_| ())
}

/// The grant the caller names, if they may take it back. Someone who may not see it, an agent apart, gets
/// `grant_not_found` whether or not it exists, so the answer says nothing about other people's grants.
fn revocable(
    sql: &SqlStorage,
    caller: &Caller,
    admin_orgs: &[String],
    grant_id: &str,
) -> R<GrantRow> {
    if caller.kind != PrincipalKind::Person {
        return Err(ApiError::not_allowed());
    }
    let org_admin = administers_room_org(sql, caller, admin_orgs)?;
    let grant = grant_rows(sql, "id = ?", vec![grant_id.into()])?
        .into_iter()
        .next()
        .filter(|g| org_admin || sees_grant(caller, &g.principal))
        .ok_or_else(|| refused(GrantRefusal::GrantNotFound))?;
    authorize_revoke(caller, &grant.principal, org_admin).map_err(denied)?;
    Ok(grant)
}

/// `GET repository/grants`: the grants that aren't revoked, for a person. A human owner or admin sees every one, and
/// anyone else their own (`sees_grant`). An agent gets `not_allowed`: it learns of its grant through a token, once step 6
/// builds that. It's a read of current rows, and `state` authorizes nothing.
pub(super) fn read_grants(sql: &SqlStorage, who: &Participant) -> R<Value> {
    let caller = &who.caller;
    if caller.kind != PrincipalKind::Person {
        return Err(ApiError::not_allowed());
    }
    let now = now_ms();
    let mut grants: Vec<Value> = vec![];
    for grant in grant_rows(sql, "revoked_at IS NULL", vec![])?
        .iter()
        .filter(|g| sees_grant(caller, &g.principal))
    {
        grants.push(grant.json(recorded_holder(sql, &grant.delegated_by)?.as_deref(), now));
    }
    Ok(json!({ "grants": grants }))
}

/// Ruling D: removing a participant, or their leaving, ends every grant they hold, in the removal's transaction.
pub(super) fn end_grants_of_removed(
    sql: &SqlStorage,
    actor: &str,
    actor_kind: &str,
    principal: &str,
    now: i64,
) -> R<()> {
    let live = grant_rows(sql, "revoked_at IS NULL", vec![])?;
    let grants: Vec<Grant> = live.iter().map(GrantRow::grant).collect();
    let ended = grants_ended_by_removal(&grants, principal);
    for grant in live.iter().filter(|g| ended.contains(&g.id.as_str())) {
        end_grant(sql, actor, actor_kind, grant, "member_removed", false, now)?;
    }
    Ok(())
}

/// Ruling B: when the room's ownership moves, every grant the new owner didn't give ends, in the transfer's transaction.
/// `new_owner` is `None` to end every grant, which recovery does: rejoining never restores earlier authority, so a
/// former owner named again starts with nothing. A transfer passes the new owner. The one before it already ended what
/// earlier owners gave, so a transfer away and back leaves none of the first owner's grants. `check_grant` refuses
/// these at use anyway; this makes the rows say so.
///
/// `displaced` is a former owner who loses their place here, as recovery for someone else makes them. They're told only of
/// that, so they aren't told of the grants they held ending, as a removed participant isn't.
pub(super) fn end_grants_after_owner_change(
    sql: &SqlStorage,
    actor: &str,
    actor_kind: &str,
    new_owner: Option<&str>,
    displaced: Option<&str>,
    now: i64,
) -> R<()> {
    let live = grant_rows(sql, "revoked_at IS NULL", vec![])?;
    let grants: Vec<Grant> = live.iter().map(GrantRow::grant).collect();
    let ended = grants_ended_by_ownership_change(&grants, new_owner);
    for grant in live.iter().filter(|g| ended.contains(&g.id.as_str())) {
        let tell = displaced != Some(grant.principal.as_str());
        end_grant(sql, actor, actor_kind, grant, "owner_changed", tell, now)?;
    }
    Ok(())
}

impl Workspace {
    /// Asks the `Principal` of a grant's giver whether they still hold the authority they gave it under: whether they've
    /// left the organization their role in this room is held in, since that role's membership began. `None` if it
    /// couldn't say. Nobody is asked about a giver the room's own rows don't make a person who is owner or admin: what
    /// they gave doesn't count, whatever their `Principal` would say.
    pub(super) async fn giver_read(&self, giver: Option<&str>) -> Option<GiverRead> {
        let Some(giver) = giver else {
            return Some(GiverRead::Nobody);
        };
        let sql = self.state.storage().sql();
        let record = recorded_giver(&sql, giver)
            .ok()?
            .filter(|record| holds_repository_delegation(record.kind, record.role, true));
        let Some(record) = record else {
            return Some(GiverRead::Nobody);
        };
        principal::departed_since(&self.env, giver, &record.org, record.since)
            .await
            .ok()
            .map(|departed| GiverRead::Asked {
                giver: giver.to_string(),
                holds: !departed,
            })
    }
}
