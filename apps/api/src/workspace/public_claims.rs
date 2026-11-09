//! Public claims, in the room (M4 step 8, decisions 151, 159 and 162). An agent whose owner allows it joins a public room
//! as a guest and claims an opening in one transaction, with no invitation and no room approval. What it may do is the
//! opening's preset, Public participant or Guest, and nothing the request says.
//!
//! The room decides from its current state, in `podster_policy::public::decide_public_claim`, then its own limits: the
//! owner's block on the agent's organization, and 20 public claims an hour. The Worker has already reserved the agent's,
//! the linking person's and the organization's counts on their `Principal`s, and settles them by this answer.
//!
//! The owner or a human admin pauses public claims and blocks organizations here. Unpublishing with "also end public
//! claims" removes every public claimant through the departure rules (decision 151).
use super::*;
use podster_core::public_claims::{check_room, claims_in_window, PublicClaimLimit};
use podster_policy::public::{
    decide_public_claim, PublicClaimRefusal, PublicClaimant, RoomStanding,
};

/// The claim itself. The Worker calls it after reserving the counts; nothing outside the Worker reaches it.
pub(crate) const INTERNAL_PUBLIC_CLAIM: &str = "/internal/public-claim";
/// Whether an agent holds a public claim here now, so the Worker can tell a retry from a new claim and end stale counts.
pub(crate) const INTERNAL_PUBLIC_CLAIM_STATUS: &str = "/internal/public-claim-status";
/// How a public claimant joined, on its member row.
const JOINED_PUBLICLY: &str = "public";

/// Whether someone is a public participant here now: they joined by a public claim and still hold the guest role it gave them.
/// One the owner has since given another role isn't, as everywhere else in public claims.
pub(super) fn is_public_participant(sql: &SqlStorage, principal: &str) -> R<bool> {
    Ok(!rows(
        sql,
        "SELECT principal_id FROM member WHERE principal_id = ? AND joined_via = ? AND role = 'guest' AND revoked_at IS NULL",
        vec![principal.into(), JOINED_PUBLICLY.into()],
    )?
    .is_empty())
}

fn refusal(refusal: PublicClaimRefusal) -> ApiError {
    let status = match refusal {
        PublicClaimRefusal::RoomHidden | PublicClaimRefusal::OpeningHidden => 404,
        PublicClaimRefusal::NotAnAgent
        | PublicClaimRefusal::PolicyRefuses
        | PublicClaimRefusal::OperatorSuspended
        | PublicClaimRefusal::Removed
        | PublicClaimRefusal::AwaitingOwnerConsent => 403,
        PublicClaimRefusal::Archived
        | PublicClaimRefusal::Paused
        | PublicClaimRefusal::PersonReviewOff
        | PublicClaimRefusal::AlreadyMember
        | PublicClaimRefusal::Full => 409,
    };
    ApiError::api(status, refusal.code())
}

fn limit(limit: PublicClaimLimit) -> ApiError {
    match limit {
        PublicClaimLimit::OrgBlocked => ApiError::api(403, limit.code()),
        _ => ApiError::limit_exceeded(),
    }
}

/// Where the agent stands in this room, from its member row.
fn standing(sql: &SqlStorage, agent: &str) -> R<RoomStanding> {
    let found = rows(
        sql,
        "SELECT revoked_at, revocation_reason, owner_consented_at FROM member WHERE principal_id = ?",
        vec![agent.into()],
    )?;
    let Some(member) = found.first() else {
        return Ok(RoomStanding::Outside);
    };
    if member["revoked_at"].is_null() {
        return Ok(RoomStanding::Member);
    }
    Ok(match member["revocation_reason"].as_str() {
        Some("room_removed") => RoomStanding::Removed,
        Some("owner_withdrawn" | "global_disconnect") if member["owner_consented_at"].is_null() => {
            RoomStanding::AwaitingOwnerConsent
        }
        _ => RoomStanding::Outside,
    })
}

/// The opening this agent holds publicly here now, and when it claimed it.
fn held(sql: &SqlStorage, agent: &str) -> R<Option<(String, Value)>> {
    Ok(rows(
        sql,
        "SELECT c.role_id, c.claimed_at FROM role_claim c JOIN member m ON m.principal_id = c.principal_id
         WHERE c.principal_id = ? AND c.status = 'active' AND c.public = 1 AND m.revoked_at IS NULL",
        vec![agent.into()],
    )?
    .first()
    .and_then(|row| text(&row["role_id"]).map(|role| (role, row["claimed_at"].clone()))))
}

/// For counting: `held` or `not_held`. A claim in an archived room reports as not held, so an archived room pins nobody's
/// count. Archiving changes nothing else about it.
pub(super) fn status(sql: &SqlStorage, url: &Url) -> R<Value> {
    let agent = url
        .query_pairs()
        .find(|(key, _)| key == "principal")
        .map(|(_, value)| value.into_owned())
        .ok_or_else(ApiError::invalid_argument)?;
    let archived = rows(sql, "SELECT status FROM workspace", vec![])?
        .first()
        .is_some_and(|row| row["status"].as_str() == Some("archived"));
    let state = if !archived && held(sql, &agent)?.is_some() {
        "held"
    } else {
        "not_held"
    };
    Ok(json!({ "state": state }))
}

/// A public claimant's membership ends with its claim, whether it released it or the room ended it, through the departure
/// rules, so strangers can't stay on as guests no limit counts. `true` if it left.
pub(super) fn leave_with_claim(
    sql: &SqlStorage,
    actor: &Caller,
    principal: &str,
    reason: &str,
    now: i64,
) -> R<bool> {
    let public = !rows(
        sql,
        // Only one still in the guest role it joined with. One the owner has since made more is the owner's to remove.
        "SELECT principal_id FROM member WHERE principal_id = ? AND joined_via = ? AND role = 'guest' AND revoked_at IS NULL",
        vec![principal.into(), JOINED_PUBLICLY.into()],
    )?
    .is_empty();
    if public {
        remove_member(sql, actor, kind_name(actor), principal, reason, now)?;
    }
    Ok(public)
}

/// When the owner gives a public participant another role, that's the owner's decision and stands: the access its claim
/// goes back to on release becomes the one the owner gave. Call before the member row changes role.
pub(super) fn owner_changed_role(
    sql: &SqlStorage,
    principal: &str,
    role: &str,
    scopes: Scopes,
) -> R<()> {
    exec(
        sql,
        "UPDATE role_claim SET prior_role = ?1, prior_tasks = ?2, prior_artifacts = ?3, prior_conversations = ?4,
           prior_review = ?5
         WHERE principal_id = ?6 AND status = 'active' AND public = 1 AND EXISTS (
           SELECT 1 FROM member WHERE principal_id = ?6 AND joined_via = ?7 AND role != ?1)",
        vec![
            role.into(),
            scopes.tasks.name().into(),
            scopes.artifacts.name().into(),
            scopes.conversations.name().into(),
            scopes.review.name().into(),
            principal.into(),
            JOINED_PUBLICLY.into(),
        ],
    )
}

/// Public claims made here in the last hour, ended ones included, since ending a claim doesn't give the hour back. Only
/// the hour's rows are read, by the index on public claims' times.
fn claims_last_hour(sql: &SqlStorage, now: i64) -> R<u32> {
    let since = now - podster_core::public_claims::PUBLIC_CLAIM_WINDOW_SECS * 1000;
    let times: Vec<i64> = rows(
        sql,
        "SELECT claimed_at FROM role_claim WHERE public = 1 AND claimed_at > ?",
        vec![since.into()],
    )?
    .iter()
    .map(|row| int(&row["claimed_at"]) / 1000)
    .collect();
    Ok(claims_in_window(&times, now / 1000))
}

fn org_blocked(sql: &SqlStorage, org: &str) -> R<bool> {
    Ok(!rows(
        sql,
        "SELECT org_id FROM public_claim_block WHERE org_id = ?",
        vec![org.into()],
    )?
    .is_empty())
}

/// An organization the room revoked can't come back by a public claim either: only a new invitation lets it return.
fn org_revoked(sql: &SqlStorage, org: &str) -> R<bool> {
    Ok(!rows(
        sql,
        "SELECT org_id FROM org_revocation WHERE org_id = ?",
        vec![org.into()],
    )?
    .is_empty())
}

/// Joins and claims, in the caller's transaction. `{ handle, role_id, generation }`, from the Worker.
pub(super) fn claim(
    sql: &SqlStorage,
    identity: &Identity,
    public_rooms_enabled: bool,
    body: &Value,
    now: i64,
) -> R<Value> {
    if identity.kind != "agent" {
        return Err(ApiError::not_allowed());
    }
    let agent = identity.id.as_str();
    let handle = body["handle"]
        .as_str()
        .ok_or_else(ApiError::workspace_not_found)?;
    let role_id = body["role_id"]
        .as_str()
        .ok_or_else(ApiError::invalid_argument)?;
    let generation = body["generation"]
        .as_u64()
        .ok_or_else(ApiError::invalid_argument)?;
    let retry_only = body["retry_only"].as_bool() == Some(true);
    let state = visibility::room_state(sql)?;
    // Asking again for the claim it already holds answers as the first time, if the room is still public under the handle.
    if let Some((role, claimed_at)) = held(sql, agent)? {
        if role == role_id
            && podster_policy::public::room_page(
                &podster_policy::public::RoomPageReader::Public(
                    podster_policy::public::PublicCaller::from_public_assertion(),
                ),
                public_rooms_enabled,
                &state,
                handle,
            )
            .is_some()
        {
            let access = access_json(
                PrincipalKind::Agent,
                parse_role("guest"),
                store::granted_scopes(sql, agent)?,
            );
            return Ok(
                json!({ "role_id": role, "principal_id": agent, "status": "active", "claimed_at": claimed_at, "access": access }),
            );
        }
    }
    let claimant = PublicClaimant {
        kind: PrincipalKind::Agent,
        // The agent's Principal refused before this if its owner hadn't allowed public claims.
        allows_public_claims: true,
        // The agent's Principal refused before this if an operator had suspended its public claims (M4 step 10).
        public_claims_suspended: false,
        standing: standing(sql, agent)?,
    };
    let preset = decide_public_claim(public_rooms_enabled, &state, handle, role_id, claimant)
        .map_err(refusal)?;
    let blocked = org_blocked(sql, &identity.org)? || org_revoked(sql, &identity.org)?;
    check_room(blocked, claims_last_hour(sql, now)?).map_err(limit)?;
    require_past_fence(sql, agent, generation)?;
    if active_count(sql)? + 1 >= MAX_MEMBERS {
        return Err(ApiError::limit_exceeded());
    }
    // Every other check passed, so this would be a new claim. The Worker counted nothing for it, on this room's word that
    // it was a retry. The claim ended since, so it's refused rather than left uncounted, and asking again counts it.
    if retry_only {
        return Err(ApiError::api(409, "version_conflict"));
    }
    write_member(
        sql,
        agent,
        agent,
        "agent",
        &identity.org,
        "guest",
        false,
        Some(generation),
        now,
    )?;
    exec(
        sql,
        "UPDATE member SET joined_via = ? WHERE principal_id = ?",
        vec![JOINED_PUBLICLY.into(), agent.into()],
    )?;
    let caller = Caller {
        id: agent.to_string(),
        kind: PrincipalKind::Agent,
        role: Role::Guest,
        scopes: Scopes::for_role(Role::Guest, false),
    };
    audit(
        sql,
        &caller,
        "member.joined_publicly",
        agent,
        None,
        Some(
            json!({ "role": "guest", "kind": "agent", "org_id": identity.org, "role_id": role_id })
                .to_string(),
        ),
        now,
    )?;
    let mut told = roles::room_managers(sql, agent)?;
    told.push(agent.to_string());
    store::record_event_about(
        sql,
        "member.added",
        agent,
        Some(agent),
        None,
        &Transition::NONE,
        told,
        now,
    )?;
    roles::claim_publicly(sql, &caller, role_id, preset, now)
}

/// Removes every public claimant now in the room through the departure rules, when the owner ends public claims on
/// unpublishing (decision 151). Each can join again by a public claim if the room is public again.
pub(super) fn end_all(sql: &SqlStorage, actor: &Caller, now: i64) -> R<u32> {
    end_public(sql, actor, None, now)
}

/// Removes the public claimants now in the room, or only one organization's, through the departure rules. Only those
/// still in the guest role they joined with: one the owner has since made more is the owner's to remove. Each can claim
/// again, unless its organization is blocked.
fn end_public(sql: &SqlStorage, actor: &Caller, org: Option<&str>, now: i64) -> R<u32> {
    let claimants: Vec<String> = rows(
        sql,
        "SELECT principal_id FROM member WHERE joined_via = ?1 AND role = 'guest' AND revoked_at IS NULL
           AND (?2 IS NULL OR org_id = ?2)",
        vec![JOINED_PUBLICLY.into(), org.map(str::to_owned).into()],
    )?
    .iter()
    .filter_map(|row| text(&row["principal_id"]))
    .collect();
    for principal in &claimants {
        remove_member(
            sql,
            actor,
            kind_name(actor),
            principal,
            "public_claims_ended",
            now,
        )?;
    }
    Ok(u32::try_from(claimants.len()).unwrap_or(u32::MAX))
}

/// `POST public-claims/end {}`: the owner or a human admin ends every public claim now, staying public, as unpublishing
/// with "also end public claims" does. Audited with the number ended. Answers as the read does, with `ended`.
pub(super) fn handle_end(sql: &SqlStorage, caller: &Caller, body: &Value, now: i64) -> R<Value> {
    ApiError::from_verdict(authorize_workroom(caller, WorkroomAction::ManageRoom))?;
    if !body.as_object().is_some_and(|fields| fields.is_empty()) {
        return Err(ApiError::invalid_argument());
    }
    let ended = end_public(sql, caller, None, now)?;
    if ended > 0 {
        audit(
            sql,
            caller,
            "public_claims.ended",
            "workspace",
            None,
            Some(json!({ "ended": ended }).to_string()),
            now,
        )?;
    }
    let mut answer = settings(sql, now)?;
    answer["ended"] = json!(ended);
    Ok(answer)
}

/// `PUT public-claims { paused }`: the owner or a human admin pauses or resumes public claims. Claims already made stay.
pub(super) fn handle_pause(sql: &SqlStorage, caller: &Caller, body: &Value, now: i64) -> R<Value> {
    ApiError::from_verdict(authorize_workroom(caller, WorkroomAction::ManageRoom))?;
    let fields = body.as_object().ok_or_else(ApiError::invalid_argument)?;
    if fields.keys().any(|k| k != "paused") {
        return Err(ApiError::invalid_argument());
    }
    let paused = body["paused"]
        .as_bool()
        .ok_or_else(ApiError::invalid_argument)?;
    let prior = rows(sql, "SELECT public_claims_paused FROM workspace", vec![])?
        .first()
        .is_some_and(|row| int(&row["public_claims_paused"]) != 0);
    if prior != paused {
        exec(
            sql,
            "UPDATE workspace SET public_claims_paused = ?",
            vec![flag(paused)],
        )?;
        audit(
            sql,
            caller,
            if paused {
                "public_claims.paused"
            } else {
                "public_claims.resumed"
            },
            "workspace",
            Some(json!({ "paused": prior }).to_string()),
            Some(json!({ "paused": paused }).to_string()),
            now,
        )?;
        record_event(
            sql,
            if paused {
                "room.public_claims_paused"
            } else {
                "room.public_claims_resumed"
            },
            &caller.id,
            None,
            &Transition::NONE,
            roles::room_managers(sql, &caller.id)?,
            now,
        )?;
    }
    settings(sql, now)
}

/// What the owner sees of public claims here: the pause switch, the blocked organizations, the room's public claims in
/// the last hour, and each public claimant now in the room, with the opening it holds, if any.
fn settings(sql: &SqlStorage, now: i64) -> R<Value> {
    let orgs: Vec<Value> = rows(
        sql,
        "SELECT org_id FROM public_claim_block ORDER BY org_id",
        vec![],
    )?
    .iter()
    .map(|row| row["org_id"].clone())
    .collect();
    let claimants: Vec<Value> = rows(
        sql,
        "SELECT m.principal_id, m.org_id, m.role, m.added_at, c.role_id, c.claimed_at FROM member m
           LEFT JOIN role_claim c ON c.principal_id = m.principal_id AND c.status = 'active' AND c.public = 1
         WHERE m.joined_via = ? AND m.role = 'guest' AND m.revoked_at IS NULL ORDER BY m.added_at, m.principal_id",
        vec![JOINED_PUBLICLY.into()],
    )?
    .iter()
    .map(|row| {
        json!({
            "principal_id": row["principal_id"], "org_id": row["org_id"], "role": row["role"],
            "joined_at": row["added_at"], "role_id": row["role_id"], "claimed_at": row["claimed_at"],
        })
    })
    .collect();
    Ok(json!({
        "paused": paused(sql)?,
        "blocked_orgs": orgs,
        "claims_last_hour": claims_last_hour(sql, now)?,
        "claimants": claimants,
    }))
}

fn paused(sql: &SqlStorage) -> R<bool> {
    Ok(
        rows(sql, "SELECT public_claims_paused FROM workspace", vec![])?
            .first()
            .is_some_and(|row| int(&row["public_claims_paused"]) != 0),
    )
}

/// Whether the caller may manage public claims here now: the owner or a human admin. Checked again before a stored
/// answer is replayed, so one demoted since can't replay it.
pub(super) fn may_manage(caller: &Caller) -> R<()> {
    ApiError::from_verdict(authorize_workroom(caller, WorkroomAction::ManageRoom))
}

/// `GET public-claims`: what the owner sees of public claims here, for the owner and human admins.
pub(super) fn read(sql: &SqlStorage, caller: &Caller, now: i64) -> R<Value> {
    ApiError::from_verdict(authorize_workroom(caller, WorkroomAction::ManageRoom))?;
    settings(sql, now)
}

/// `PUT` or `DELETE public-claims/blocked-orgs/{org}`: the owner or a human admin blocks an organization's agents from
/// claiming publicly here, or lifts that. A block ends no claim already made, unless `PUT` says `{ end_claims: true }`:
/// then that organization's public claimants leave too, through the departure rules.
pub(super) fn handle_block(
    sql: &SqlStorage,
    caller: &Caller,
    org: &str,
    blocked: bool,
    body: &Value,
    now: i64,
) -> R<Value> {
    ApiError::from_verdict(authorize_workroom(caller, WorkroomAction::ManageRoom))?;
    require_id(org)?;
    // Only a block can end claims. Lifting one reads no body, as before.
    let end_claims = if blocked {
        let fields = match body {
            Value::Null => serde_json::Map::new(),
            Value::Object(fields) => fields.clone(),
            _ => return Err(ApiError::invalid_argument()),
        };
        if fields.keys().any(|k| k != "end_claims") {
            return Err(ApiError::invalid_argument());
        }
        match fields.get("end_claims") {
            None => false,
            Some(value) => value.as_bool().ok_or_else(ApiError::invalid_argument)?,
        }
    } else {
        false
    };
    let prior = org_blocked(sql, org)?;
    if prior != blocked {
        if blocked {
            exec(
                sql,
                "INSERT INTO public_claim_block (org_id, blocked_by, blocked_at) VALUES (?, ?, ?)",
                vec![org.into(), caller.id.as_str().into(), now.into()],
            )?;
        } else {
            exec(
                sql,
                "DELETE FROM public_claim_block WHERE org_id = ?",
                vec![org.into()],
            )?;
        }
        let action = if blocked {
            "public_claims.org_blocked"
        } else {
            "public_claims.org_unblocked"
        };
        audit(
            sql,
            caller,
            action,
            org,
            Some(json!({ "blocked": prior }).to_string()),
            Some(json!({ "blocked": blocked }).to_string()),
            now,
        )?;
        record_event(
            sql,
            if blocked {
                "room.org_blocked"
            } else {
                "room.org_unblocked"
            },
            &caller.id,
            None,
            &Transition::NONE,
            roles::room_managers(sql, &caller.id)?,
            now,
        )?;
    }
    if !end_claims {
        return settings(sql, now);
    }
    let ended = end_public(sql, caller, Some(org), now)?;
    if ended > 0 {
        audit(
            sql,
            caller,
            "public_claims.ended",
            org,
            None,
            Some(json!({ "ended": ended }).to_string()),
            now,
        )?;
    }
    let mut answer = settings(sql, now)?;
    answer["ended"] = json!(ended);
    Ok(answer)
}
