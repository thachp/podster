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

/// `GET repository`: the room's request for a repository and its linked repository, each null if there's none. For
/// a person who sees the whole room, never an agent: the contract lists it as person-only, and an agent will learn of the
/// repository through `get_repo_access`, once step 6 builds it. It's a read of current state and authorizes nothing.
pub(super) fn read(sql: &SqlStorage, who: &Participant) -> R<Value> {
    if who.caller.kind != PrincipalKind::Person || !sees_whole_room(&who.caller) {
        return Err(ApiError::not_allowed());
    }
    let request = rows(sql, "SELECT id, state, name, visibility, reason, requested_by, requested_at, updated_at FROM repo_request", vec![])?
        .first()
        .map_or(Value::Null, |r| json!({
            "id": r["id"], "state": r["state"], "name": r["name"], "visibility": r["visibility"], "reason": r["reason"],
            "requested_by": r["requested_by"], "requested_at": r["requested_at"], "updated_at": r["updated_at"],
        }));
    let repository = rows(sql, "SELECT id, provider, provider_repo_id, full_name, visibility, default_branch, status, status_reason, created_at, verified_at, updated_at FROM repo_link", vec![])?
        .first()
        .map_or(Value::Null, |r| json!({
            "id": r["id"], "provider": r["provider"], "provider_repo_id": r["provider_repo_id"], "full_name": r["full_name"],
            "visibility": r["visibility"], "default_branch": r["default_branch"], "status": r["status"],
            "status_reason": r["status_reason"], "created_at": r["created_at"], "verified_at": r["verified_at"],
            "updated_at": r["updated_at"],
        }));
    Ok(json!({ "request": request, "repository": repository }))
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
                "UPDATE task_change SET nudged_at = ? WHERE task_id = ?",
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

/// Writes the room's row in `repo_room_index`, once, after its link exists. The row routes a delivery here and authorizes
/// nothing. A repository ID another room already holds is left with that room and logged by ID, and this room's row is
/// marked as refused with a zero so the alarm doesn't keep trying: deliveries for it then reach the other room, which drops
/// them unless the repository really is its own.
pub(super) async fn drain_index(sql: &SqlStorage, db: &D1Database) -> R<()> {
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
    let ours = holder
        .as_ref()
        .and_then(|found| found["workspace_id"].as_str())
        == Some(room.as_str());
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
            Ok(db) => drain_index(sql, &db).await,
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
