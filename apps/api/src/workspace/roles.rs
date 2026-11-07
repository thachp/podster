//! Work roles: openings, invites to them, claims and release. Decisions come from `crates/core` and `crates/policy`, and
//! everything here runs inside the room's command transaction. A claim fills a responsibility and copies its preset. It
//! never carries admin, merge or deploy authority, and it isn't acceptance of any task.
use super::*;

const MAX_ROLES: i64 = 50;
const CARD_GOAL_CHARS: i64 = 200;
const CARD_ROLES: usize = 3;
const ACTIVE: &str = "active";

/// The owner, if they haven't left, and the room's admins: who hears about changes to its openings.
fn room_managers(sql: &SqlStorage, except: &str) -> R<Vec<String>> {
    let mut managers: Vec<String> = rows(
        sql,
        "SELECT principal_id FROM member WHERE role = 'admin' AND revoked_at IS NULL",
        vec![],
    )?
    .iter()
    .filter_map(|member| text(&member["principal_id"]))
    .collect();
    managers.extend(
        rows(
            sql,
            "SELECT owner_person_id FROM workspace WHERE owner_left_at IS NULL",
            vec![],
        )?
        .iter()
        .filter_map(|room| text(&room["owner_person_id"])),
    );
    managers.retain(|principal| principal != except);
    Ok(managers)
}

fn open_role(sql: &SqlStorage, id: &str) -> R<Value> {
    rows(
        sql,
        "SELECT * FROM work_role WHERE id = ? AND closed_at IS NULL",
        vec![id.into()],
    )?
    .into_iter()
    .next()
    .ok_or_else(ApiError::role_not_found)
}

fn active_claims(sql: &SqlStorage, role: &str) -> R<i64> {
    Ok(rows(
        sql,
        "SELECT count(*) AS n FROM role_claim WHERE role_id = ? AND status = 'active'",
        vec![role.into()],
    )?
    .first()
    .map_or(0, |row| int(&row["n"])))
}

fn lead_exists(sql: &SqlStorage) -> R<bool> {
    Ok(!rows(
        sql,
        "SELECT id FROM work_role WHERE is_lead = 1 AND closed_at IS NULL",
        vec![],
    )?
    .is_empty())
}

fn parse_preset(name: &str) -> R<Preset> {
    Preset::from_name(name).ok_or_else(ApiError::invalid_argument)
}

fn capacity_field(body: &Value) -> R<Option<i64>> {
    match body.get("capacity") {
        None => Ok(None),
        Some(value) => value
            .as_i64()
            .map(Some)
            .ok_or_else(ApiError::invalid_argument),
    }
}

fn lead_field(body: &Value) -> R<Option<bool>> {
    match body.get("is_lead") {
        None => Ok(None),
        Some(value) => value
            .as_bool()
            .map(Some)
            .ok_or_else(ApiError::invalid_argument),
    }
}

fn role_json(row: &Value, filled: i64) -> Value {
    json!({
        "id": row["id"], "title": row["title"], "responsibilities": row["responsibilities"], "capacity": row["capacity"],
        "filled": filled, "preset": row["preset"], "is_lead": int(&row["is_lead"]) != 0, "version": row["version"], "created_by": row["created_by"],
    })
}

/// A role's configuration for the audit log. Its title and responsibilities are written text, so they stay out.
fn role_audit(capacity: i64, preset: &str, is_lead: bool) -> String {
    json!({ "capacity": capacity, "preset": preset, "is_lead": is_lead }).to_string()
}

pub(super) fn handle_create_role(
    sql: &SqlStorage,
    caller: &Caller,
    body: &Value,
    now: i64,
) -> R<Value> {
    ApiError::from_verdict(authorize_workroom(caller, WorkroomAction::ManageAccess))?;
    require_policy_version(sql, body)?;
    let title = required(body, "title")?;
    let responsibilities = required(body, "responsibilities")?;
    let is_lead = lead_field(body)?.unwrap_or(false);
    let given_preset = field(body, "preset")?;
    let given_capacity = capacity_field(body)?;
    // A lead is always one opening with the Coordinator preset, so asking for anything else is a mistake to report.
    let (preset, capacity) = if is_lead {
        if given_capacity.is_some_and(|c| c != 1)
            || given_preset
                .as_deref()
                .is_some_and(|p| p != Preset::Coordinator.name())
        {
            return Err(ApiError::invalid_argument());
        }
        (Preset::Coordinator, 1)
    } else {
        (
            parse_preset(&given_preset.ok_or_else(ApiError::invalid_argument)?)?,
            given_capacity.unwrap_or(1),
        )
    };
    validate_role(&title, &responsibilities, capacity).map_err(|e| ApiError::from_core(&e))?;
    if is_lead && lead_exists(sql)? {
        return Err(ApiError::lead_exists());
    }
    let count = rows(
        sql,
        "SELECT count(*) AS n FROM work_role WHERE closed_at IS NULL",
        vec![],
    )?
    .first()
    .map_or(0, |row| int(&row["n"]));
    if count >= MAX_ROLES {
        return Err(ApiError::limit_exceeded());
    }
    let id = format!("rol_{}", uuid::Uuid::new_v4().simple());
    exec(sql, "INSERT INTO work_role (id, title, responsibilities, capacity, preset, is_lead, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", vec![
        id.as_str().into(), title.as_str().into(), responsibilities.as_str().into(), capacity.into(), preset.name().into(), flag(is_lead), caller.id.as_str().into(), now.into(),
    ])?;
    audit(
        sql,
        caller,
        "role.created",
        &id,
        None,
        Some(role_audit(capacity, preset.name(), is_lead)),
        now,
    )?;
    let mut everyone = room_people(sql)?;
    everyone.retain(|principal| *principal != caller.id);
    record_event(
        sql,
        "role.created",
        &caller.id,
        None,
        &Transition::NONE,
        everyone,
        now,
    )?;
    Ok(role_json(&open_role(sql, &id)?, 0))
}

pub(super) fn handle_update_role(
    sql: &SqlStorage,
    caller: &Caller,
    id: &str,
    body: &Value,
    now: i64,
) -> R<Value> {
    ApiError::from_verdict(authorize_workroom(caller, WorkroomAction::ManageAccess))?;
    require_policy_version(sql, body)?;
    let role = open_role(sql, id)?;
    let was_lead = int(&role["is_lead"]) != 0;
    let is_lead = lead_field(body)?.unwrap_or(was_lead);
    let filled = active_claims(sql, id)?;
    if is_lead != was_lead {
        // A holder's scopes were copied from the role they claimed, so the mark moves only while nobody holds it.
        if filled > 0 {
            return Err(ApiError::from_core(
                &podster_core::CoreError::InvalidTransition,
            ));
        }
        if is_lead && lead_exists(sql)? {
            return Err(ApiError::lead_exists());
        }
    }
    let title = field(body, "title")?
        .or_else(|| text(&role["title"]))
        .unwrap_or_default();
    let responsibilities = field(body, "responsibilities")?
        .or_else(|| text(&role["responsibilities"]))
        .unwrap_or_default();
    let given_preset = field(body, "preset")?;
    let given_capacity = capacity_field(body)?;
    let (preset, capacity) = if is_lead {
        if given_capacity.is_some_and(|c| c != 1)
            || given_preset
                .as_deref()
                .is_some_and(|p| p != Preset::Coordinator.name())
        {
            return Err(ApiError::invalid_argument());
        }
        (Preset::Coordinator, 1)
    } else {
        let name = given_preset
            .or_else(|| text(&role["preset"]))
            .unwrap_or_default();
        (
            parse_preset(&name)?,
            given_capacity.unwrap_or_else(|| int(&role["capacity"])),
        )
    };
    validate_role(&title, &responsibilities, capacity).map_err(|e| ApiError::from_core(&e))?;
    // What an agent agreed to look at isn't what they'd now get, so anything already offered goes with the old terms.
    if role["preset"].as_str() != Some(preset.name()) || is_lead != was_lead {
        withdraw_offers_of_role(sql, id)?;
    }
    // Lowering capacity below the holders blocks further claims and removes nobody. Holders keep what they copied.
    exec(sql, "UPDATE work_role SET title = ?, responsibilities = ?, capacity = ?, preset = ?, is_lead = ?, version = version + 1 WHERE id = ?", vec![
        title.as_str().into(), responsibilities.as_str().into(), capacity.into(), preset.name().into(), flag(is_lead), id.into(),
    ])?;
    audit(
        sql,
        caller,
        "role.updated",
        id,
        Some(role_audit(
            int(&role["capacity"]),
            role["preset"].as_str().unwrap_or_default(),
            was_lead,
        )),
        Some(role_audit(capacity, preset.name(), is_lead)),
        now,
    )?;
    let mut everyone = room_people(sql)?;
    everyone.retain(|principal| *principal != caller.id);
    record_event(
        sql,
        "role.updated",
        &caller.id,
        None,
        &Transition::NONE,
        everyone,
        now,
    )?;
    Ok(role_json(&open_role(sql, id)?, filled))
}

/// Closes a vacant opening. Holders have to be ended first, so nobody loses a claim as a side effect.
pub(super) fn handle_close_role(
    sql: &SqlStorage,
    caller: &Caller,
    id: &str,
    body: &Value,
    now: i64,
) -> R<Value> {
    ApiError::from_verdict(authorize_workroom(caller, WorkroomAction::ManageAccess))?;
    require_policy_version(sql, body)?;
    open_role(sql, id)?;
    if active_claims(sql, id)? > 0 {
        return Err(ApiError::from_core(
            &podster_core::CoreError::InvalidTransition,
        ));
    }
    exec(
        sql,
        "UPDATE work_role SET closed_at = ? WHERE id = ?",
        vec![now.into(), id.into()],
    )?;
    withdraw_offers_of_role(sql, id)?;
    planned::hide_with_role(sql, caller, id, now)?;
    audit(sql, caller, "role.closed", id, None, None, now)?;
    let mut everyone = room_people(sql)?;
    everyone.retain(|principal| *principal != caller.id);
    record_event(
        sql,
        "role.closed",
        &caller.id,
        None,
        &Transition::NONE,
        everyone,
        now,
    )?;
    Ok(json!({ "id": id, "closed": true }))
}

/// Names a current agent for an opening. It stays that agent's choice whether to claim, because a room's owner or admin
/// can't claim for another owner's agent, and an invite grants nothing until then.
pub(super) fn handle_invite_to_role(
    sql: &SqlStorage,
    caller: &Caller,
    id: &str,
    body: &Value,
    now: i64,
) -> R<Value> {
    ApiError::from_verdict(authorize_workroom(caller, WorkroomAction::ManageAccess))?;
    require_policy_version(sql, body)?;
    open_role(sql, id)?;
    let principal = required(body, "principal_id")?;
    require_id(&principal)?;
    let found = rows(
        sql,
        "SELECT kind FROM member WHERE principal_id = ? AND revoked_at IS NULL",
        vec![principal.as_str().into()],
    )?;
    if found.first().and_then(|m| m["kind"].as_str()) != Some("agent") {
        return Err(ApiError::invalid_argument());
    }
    add_invite(sql, caller, &caller.id, id, &principal, now)?;
    Ok(json!({ "role_id": id, "principal_id": principal }))
}

/// Records an invite and tells the agent, in the caller's transaction.
pub(super) fn add_invite(
    sql: &SqlStorage,
    actor: &Caller,
    invited_by: &str,
    role: &str,
    principal: &str,
    now: i64,
) -> R<()> {
    exec(sql, "INSERT OR REPLACE INTO role_invite (role_id, principal_id, invited_by, created_at) VALUES (?, ?, ?, ?)", vec![
        role.into(), principal.into(), invited_by.into(), now.into(),
    ])?;
    audit(
        sql,
        actor,
        "role.invited",
        principal,
        None,
        Some(json!({ "role_id": role }).to_string()),
        now,
    )?;
    store::record_event_about(
        sql,
        "role.invited",
        &actor.id,
        Some(principal),
        None,
        &Transition::NONE,
        [principal.to_string()],
        now,
    )
}

pub(super) fn handle_withdraw_role_invite(
    sql: &SqlStorage,
    caller: &Caller,
    id: &str,
    principal: &str,
    body: &Value,
    now: i64,
) -> R<Value> {
    ApiError::from_verdict(authorize_workroom(caller, WorkroomAction::ManageAccess))?;
    require_policy_version(sql, body)?;
    let found = rows(
        sql,
        "SELECT role_id FROM role_invite WHERE role_id = ? AND principal_id = ?",
        vec![id.into(), principal.into()],
    )?;
    if found.is_empty() {
        return Err(ApiError::invalid_argument());
    }
    exec(
        sql,
        "DELETE FROM role_invite WHERE role_id = ? AND principal_id = ?",
        vec![id.into(), principal.into()],
    )?;
    audit(
        sql,
        caller,
        "role.invite_withdrawn",
        principal,
        Some(json!({ "role_id": id }).to_string()),
        None,
        now,
    )?;
    Ok(json!({ "role_id": id, "principal_id": principal, "withdrawn": true }))
}

/// Whether whoever made an invite can still make one. Someone who has since lost that authority no longer speaks for the
/// room, so what they offered is gone.
fn inviter_still_manages(sql: &SqlStorage, invited_by: &str) -> R<bool> {
    Ok(participant(sql, invited_by)?
        .is_some_and(|(kind, role)| kind == "person" && (role == "owner" || role == "admin")))
}

/// An opening's offer changed, so what was offered isn't what's on offer now. This covers named agents and pending links.
fn withdraw_offers_of_role(sql: &SqlStorage, role: &str) -> R<()> {
    exec(
        sql,
        "DELETE FROM role_invite WHERE role_id = ?",
        vec![role.into()],
    )?;
    exec(
        sql,
        "UPDATE invitation SET work_role_id = NULL WHERE work_role_id = ? AND status = 'pending'",
        vec![role.into()],
    )
}

/// A room changed this agent's access, so an invite made before that can't later undo the change.
pub(super) fn withdraw_role_invites(sql: &SqlStorage, principal: &str) -> R<()> {
    exec(
        sql,
        "DELETE FROM role_invite WHERE principal_id = ?",
        vec![principal.into()],
    )
}

fn claim_json(role: &str, principal: &str, access: Value, claimed_at: &Value) -> Value {
    json!({ "role_id": role, "principal_id": principal, "status": ACTIVE, "claimed_at": claimed_at, "access": access })
}

/// Fills an opening, as one step of the room's single writer, so simultaneous claims can't overfill it. Asking again
/// changes nothing. Scopes come only from the opening's preset, never from the request.
pub(super) fn handle_claim_role(sql: &SqlStorage, caller: &Caller, id: &str, now: i64) -> R<Value> {
    if !may_claim_role(caller.kind) {
        return Err(ApiError::not_allowed());
    }
    let role = open_role(sql, id)?;
    let held = rows(
        sql,
        "SELECT role_id, claimed_at FROM role_claim WHERE principal_id = ? AND status = 'active'",
        vec![caller.id.as_str().into()],
    )?;
    let holds_this = held.first().and_then(|c| c["role_id"].as_str()) == Some(id);
    let invite = rows(
        sql,
        "SELECT invited_by FROM role_invite WHERE role_id = ? AND principal_id = ?",
        vec![id.into(), caller.id.as_str().into()],
    )?;
    let invited = match invite.first().and_then(|row| row["invited_by"].as_str()) {
        Some(invited_by) => inviter_still_manages(sql, invited_by)?,
        None => false,
    };
    let outcome = decide_claim(&ClaimState {
        holds_this,
        holds_another: !holds_this && !held.is_empty(),
        invited,
        filled: active_claims(sql, id)?,
        capacity: int(&role["capacity"]),
    })
    .map_err(|refusal| match refusal {
        ClaimRefusal::NotInvited => ApiError::not_allowed(),
        ClaimRefusal::Full => ApiError::role_full(),
        ClaimRefusal::HoldsAnother => ApiError::already_claimed(),
    })?;
    if outcome == ClaimOutcome::AlreadyHeld {
        let claimed_at = held
            .first()
            .map_or(Value::Null, |c| c["claimed_at"].clone());
        return Ok(claim_json(
            id,
            &caller.id,
            access_json(caller.kind, caller.role, caller.scopes),
            &claimed_at,
        ));
    }
    let preset = parse_preset(role["preset"].as_str().unwrap_or_default())?;
    let found = rows(
        sql,
        "SELECT role, org_id FROM member WHERE principal_id = ?",
        vec![caller.id.as_str().into()],
    )?;
    let member = found.first().ok_or_else(ApiError::not_allowed)?;
    let prior_role = text(&member["role"]).unwrap_or_default();
    let org = text(&member["org_id"]).unwrap_or_default();
    let prior = store::granted_scopes(sql, &caller.id)?;
    let next = preset.scopes();
    // Write the grant first, so the claim records the version anything later is compared with.
    set_access(
        sql,
        &caller.id,
        &org,
        &prior_role,
        preset.role_name(),
        next,
        &caller.id,
        now,
    )?;
    let grant_version = store::grant_version(sql, &caller.id)?;
    exec(sql, "INSERT INTO role_claim (id, role_id, principal_id, status, claimed_at, copied_preset, grant_version, prior_role, prior_tasks, prior_artifacts, prior_conversations, prior_review)
      VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)", vec![
        format!("clm_{}", uuid::Uuid::new_v4().simple()).into(), id.into(), caller.id.as_str().into(), now.into(), preset.name().into(), grant_version.into(), prior_role.as_str().into(),
        prior.tasks.name().into(), prior.artifacts.name().into(), prior.conversations.name().into(), prior.review.name().into(),
    ])?;
    exec(
        sql,
        "DELETE FROM role_invite WHERE role_id = ? AND principal_id = ?",
        vec![id.into(), caller.id.as_str().into()],
    )?;
    let parsed = parse_role(preset.role_name());
    audit(
        sql,
        caller,
        "role.claimed",
        &caller.id,
        Some(json!({ "role_id": id, "role": prior_role, "access": access_json(caller.kind, parse_role(&prior_role), prior) }).to_string()),
        Some(json!({ "role_id": id, "role": preset.role_name(), "access": access_json(caller.kind, parsed, next) }).to_string()),
        now,
    )?;
    record_event(
        sql,
        "role.claimed",
        &caller.id,
        None,
        &Transition::NONE,
        room_managers(sql, &caller.id)?,
        now,
    )?;
    review_after_change(sql, caller, &caller.id, prior, next, now)?;
    Ok(claim_json(
        id,
        &caller.id,
        access_json(caller.kind, parsed, next),
        &json!(now),
    ))
}

/// Writes a participant's grant and the role that goes with it.
#[allow(clippy::too_many_arguments)]
fn set_access(
    sql: &SqlStorage,
    principal: &str,
    org: &str,
    prior_role: &str,
    role: &str,
    scopes: Scopes,
    by: &str,
    now: i64,
) -> R<()> {
    store::write_grant(sql, principal, scopes, by, now)?;
    exec(
        sql,
        "UPDATE member SET role = ?, guest_can_create = ? WHERE principal_id = ?",
        vec![
            role.into(),
            flag(role == "guest" && scopes.tasks.can_create()),
            principal.into(),
        ],
    )?;
    if role != prior_role {
        queue_index(sql, principal, org, Some(role), now)?;
    }
    // Ending a claim can take away what let someone upload.
    let by_kind = if by.starts_with(AGENT_ID_PREFIX) {
        "agent"
    } else {
        "person"
    };
    super::objects::drop_uploads_no_longer_allowed(sql, by, by_kind, principal, now)
}

/// Ends someone's active claim, if they have one, and works out what they keep. If nobody touched their grant while they
/// held the opening, they go back to what they had. If someone did, they keep the narrower, so a room's decision stands. `departing` is for someone leaving the room, whose tasks the departure rules are about to handle.
#[allow(clippy::too_many_arguments)]
pub(super) fn end_claim(
    sql: &SqlStorage,
    actor: &Caller,
    actor_kind: &str,
    principal: &str,
    status: &str,
    reason: &str,
    departing: bool,
    now: i64,
) -> R<Option<Scopes>> {
    let found = rows(
        sql,
        "SELECT * FROM role_claim WHERE principal_id = ? AND status = 'active'",
        vec![principal.into()],
    )?;
    let Some(claim) = found.first() else {
        return Ok(None);
    };
    let role_id = text(&claim["role_id"]).unwrap_or_default();
    let members = rows(
        sql,
        "SELECT kind, role, org_id FROM member WHERE principal_id = ?",
        vec![principal.into()],
    )?;
    let member = members
        .first()
        .ok_or_else(|| ApiError::internal("claim without a member"))?;
    let kind = member["kind"]
        .as_str()
        .map_or(PrincipalKind::Agent, parse_kind);
    let current_role = text(&member["role"]).unwrap_or_default();
    let org = text(&member["org_id"]).unwrap_or_default();
    let current = store::granted_scopes(sql, principal)?;
    let prior = store::scopes_from(claim, "prior_")?;
    let prior_role = text(&claim["prior_role"]).unwrap_or_default();
    // The version, not the values: a room can lock someone at exactly what they already hold.
    let untouched = store::grant_version(sql, principal)? == int(&claim["grant_version"]);
    let next = scopes_after_claim(prior, current, untouched);
    let role = if untouched {
        prior_role
    } else {
        current_role.clone()
    };
    exec(
        sql,
        "UPDATE role_claim SET status = ?, ended_at = ?, end_reason = ? WHERE id = ?",
        vec![
            status.into(),
            now.into(),
            reason.into(),
            claim["id"].as_str().unwrap_or_default().into(),
        ],
    )?;
    set_access(
        sql,
        principal,
        &org,
        &current_role,
        &role,
        next,
        &actor.id,
        now,
    )?;
    audit_as(
        sql,
        &actor.id,
        actor_kind,
        "role.claim_ended",
        principal,
        Some(json!({ "role_id": role_id, "role": current_role, "access": access_json(kind, parse_role(&current_role), current) }).to_string()),
        Some(json!({ "role_id": role_id, "role": role, "reason": reason, "access": access_json(kind, parse_role(&role), next) }).to_string()),
        now,
    )?;
    let mut told = room_managers(sql, &actor.id)?;
    if principal != actor.id && !departing {
        told.push(principal.to_string());
    }
    store::record_event_about(
        sql,
        "role.claim_ended",
        &actor.id,
        // Someone departing isn't told, so if they come back limited, their Activity mustn't show what their inbox never did.
        (!departing).then_some(principal),
        None,
        &Transition::NONE,
        told,
        now,
    )?;
    if !departing {
        review_after_change(sql, actor, principal, current, next, now)?;
    }
    Ok(Some(next))
}

pub(super) fn handle_release_role(
    sql: &SqlStorage,
    caller: &Caller,
    id: &str,
    now: i64,
) -> R<Value> {
    open_role(sql, id)?;
    let held = rows(
        sql,
        "SELECT role_id FROM role_claim WHERE principal_id = ? AND role_id = ? AND status = 'active'",
        vec![caller.id.as_str().into(), id.into()],
    )?;
    if held.is_empty() {
        return Err(ApiError::from_core(
            &podster_core::CoreError::InvalidTransition,
        ));
    }
    let scopes = end_claim(
        sql,
        caller,
        kind_name(caller),
        &caller.id,
        "released",
        "released",
        false,
        now,
    )?
    .unwrap_or(caller.scopes);
    let role = rows(
        sql,
        "SELECT role FROM member WHERE principal_id = ?",
        vec![caller.id.as_str().into()],
    )?
    .first()
    .map_or(Role::None, |m| {
        m["role"].as_str().map_or(Role::None, parse_role)
    });
    Ok(
        json!({ "role_id": id, "status": "released", "access": access_json(caller.kind, role, scopes) }),
    )
}

/// An owner or admin ends a holder's claim, which is how a lead is replaced. Open tasks don't move with it: that takes a
/// recorded `set_requester`.
pub(super) fn handle_end_claim(
    sql: &SqlStorage,
    caller: &Caller,
    id: &str,
    principal: &str,
    body: &Value,
    now: i64,
) -> R<Value> {
    ApiError::from_verdict(authorize_workroom(caller, WorkroomAction::ManageAccess))?;
    require_policy_version(sql, body)?;
    open_role(sql, id)?;
    let held = rows(
        sql,
        "SELECT role_id FROM role_claim WHERE principal_id = ? AND role_id = ? AND status = 'active'",
        vec![principal.into(), id.into()],
    )?;
    if held.is_empty() {
        return Err(ApiError::invalid_argument());
    }
    let scopes = end_claim(
        sql,
        caller,
        kind_name(caller),
        principal,
        "revoked",
        "ended_by_room",
        false,
        now,
    )?
    .unwrap_or(Scopes::PUBLIC_PARTICIPANT);
    // Ending this isn't an opening to claim another straight away. What the room offered before no longer stands.
    withdraw_role_invites(sql, principal)?;
    let found = rows(
        sql,
        "SELECT kind, role FROM member WHERE principal_id = ?",
        vec![principal.into()],
    )?;
    let member = found.first().ok_or_else(ApiError::invalid_argument)?;
    let kind = member["kind"]
        .as_str()
        .map_or(PrincipalKind::Agent, parse_kind);
    let role = member["role"].as_str().map_or(Role::None, parse_role);
    Ok(
        json!({ "role_id": id, "principal_id": principal, "status": "revoked", "access": access_json(kind, role, scopes) }),
    )
}

/// What a directory card shows of this room, for this viewer. It follows `list_roles` and `get_brief`, so it tells no one
/// more than those would. It's one query, whose cost follows the room's open roles and active claims, plus one row read for
/// each closed role, because those have no index.
pub(super) fn read_card(sql: &SqlStorage, who: &Participant) -> R<Value> {
    let room = rows(sql, "SELECT substr(goal, 1, ?) AS goal, length(goal) AS goal_length, owner_org_id FROM workspace", vec![(CARD_GOAL_CHARS + 1).into()])?;
    let room = room.first().ok_or_else(ApiError::workspace_not_found)?;
    let found = rows(
        sql,
        "SELECT r.title, r.capacity, count(c.principal_id) AS filled FROM work_role r
           LEFT JOIN role_claim c ON c.role_id = r.id AND c.status = 'active'
          WHERE r.closed_at IS NULL GROUP BY r.id ORDER BY r.is_lead DESC, r.created_at, r.id",
        vec![],
    )?;
    let whole_room = sees_whole_room(&who.caller);
    let role_json = |row: &Value| {
        let (filled, capacity) = (int(&row["filled"]), int(&row["capacity"]));
        if whole_room {
            json!({ "title": row["title"], "filled": filled, "capacity": capacity })
        } else {
            json!({ "title": row["title"], "available": filled < capacity })
        }
    };
    let mut roles = json!({
        "count": found.len(),
        "with_openings": found.iter().filter(|row| int(&row["filled"]) < int(&row["capacity"])).count(),
        "listed": found.iter().take(CARD_ROLES).map(role_json).collect::<Vec<_>>(),
    });
    if whole_room {
        roles["filled"] = json!(found.iter().map(|row| int(&row["filled"])).sum::<i64>());
        roles["capacity"] = json!(found.iter().map(|row| int(&row["capacity"])).sum::<i64>());
    }
    let goal: String = room["goal"]
        .as_str()
        .unwrap_or_default()
        .chars()
        .take(CARD_GOAL_CHARS as usize)
        .collect();
    Ok(json!({
        "goal": if room["goal"].is_null() { Value::Null } else { json!(goal) },
        "goal_cut": int(&room["goal_length"]) > CARD_GOAL_CHARS,
        "external": room["owner_org_id"].as_str() != Some(who.org.as_str()),
        "roles": roles,
    }))
}

/// The room's openings, for anyone in it. Who holds them, and how many do, follow the same limit as the member list, so
/// someone limited to their own tasks sees only whether one's available and their own place.
pub(super) fn list_roles(sql: &SqlStorage, who: &Participant) -> R<Value> {
    let caller = &who.caller;
    let found = rows(
        sql,
        "SELECT * FROM work_role WHERE closed_at IS NULL ORDER BY is_lead DESC, created_at, id",
        vec![],
    )?;
    let manages = authorize_workroom(caller, WorkroomAction::ManageAccess) == Verdict::Allow;
    let whole_room = sees_whole_room(caller);
    let owner_org = room_owner_org(sql)?;
    let mut listed = Vec::with_capacity(found.len());
    for row in &found {
        let id = row["id"].as_str().unwrap_or_default();
        let holders: Vec<String> = rows(
            sql,
            "SELECT principal_id FROM role_claim WHERE role_id = ? AND status = 'active' ORDER BY claimed_at",
            vec![id.into()],
        )?
        .iter()
        .filter_map(|claim| text(&claim["principal_id"]))
        .collect();
        let mut invites = Vec::new();
        for invite in rows(
            sql,
            "SELECT principal_id, invited_by FROM role_invite WHERE role_id = ? ORDER BY created_at",
            vec![id.into()],
        )? {
            if inviter_still_manages(sql, invite["invited_by"].as_str().unwrap_or_default())? {
                invites.extend(text(&invite["principal_id"]));
            }
        }
        let mut entry = role_json(row, holders.len() as i64);
        entry["mine"] = if holders.contains(&caller.id) {
            json!("claimed")
        } else if invites.contains(&caller.id) {
            json!("invited")
        } else {
            Value::Null
        };
        if whole_room {
            entry["holders"] = json!(holders);
        } else if let Some(fields) = entry.as_object_mut() {
            // Counts follow what they can see, so someone limited to their own tasks learns only if one's available.
            fields.remove("filled");
            fields.insert(
                "available".into(),
                json!((holders.len() as i64) < int(&row["capacity"])),
            );
        }
        if manages {
            entry["invited"] = json!(invites);
        }
        listed.push(entry);
    }
    // Written by the room's owner or admins, and for reading only.
    Ok(json!({ "roles": listed, "external": owner_org != who.org }))
}
