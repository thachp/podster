//! Inviting a person from another organization (decisions 239 to 247, docs/spec/CROSS-ORG-PEOPLE.md), and leaving a room.
//!
//! The room's owner or an admin invites one email address. Only a signed-in person whose verified email matches, which the
//! gateway states from its own rows on the preview and accept routes alone, may see what the link offers or accept it. They
//! join as one of their own organizations other than the room's, as a guest or a member, never admin. Accepting adds the
//! person only. Every refusal a link can give before the address matches is `invitation_not_found`.
//!
//! The address lives on `invitation_invitee` while the invitation is pending and is erased when it ends: accepted,
//! withdrawn, replaced, ended with its creator's authority, or expired (`erase_ended`, also run by the alarm). It never
//! reaches an audit entry, an event, a log line or anyone but the owner and admins.
use super::*;
use podster_policy::person_invitation_role_allowed;

/// At most this many pending person invitations in a room, and this many made in a day.
const MAX_PENDING: i64 = 20;
const MAX_PER_DAY: i64 = 20;
const MAX_EMAIL_BYTES: usize = 254;

/// An address as the room keeps and compares it: trimmed and lowercased, with one `@` and something either side of it.
/// It isn't a full check of the address. The link only works for whoever signs in with it verified.
pub(super) fn normalize_email(raw: &str) -> Option<String> {
    let email = raw.trim().to_lowercase();
    let (local, domain) = email.split_once('@')?;
    let valid = !local.is_empty()
        && !domain.is_empty()
        && !domain.contains('@')
        && email.len() <= MAX_EMAIL_BYTES
        && !email.chars().any(|c| c.is_whitespace() || c.is_control());
    valid.then_some(email)
}

/// A command's body as its idempotency fingerprint sees it: a person invitation's address left out. The record is kept,
/// and an unsalted hash of a body holding the address would confirm a guessed one; the key and the other fields still
/// tell a retry from a different request (the architect's ruling on #533's review).
pub(super) fn fingerprint_body(body: &Value) -> Value {
    let mut body = body.clone();
    if let Some(invitee) = body.get_mut("invitee").and_then(Value::as_object_mut) {
        invitee.remove("email");
    }
    body
}

/// Whether an invitation is for a person, and the address it still holds (none once it ended).
pub(super) fn invitee(sql: &SqlStorage, invitation: &str) -> R<Option<Option<String>>> {
    Ok(rows(
        sql,
        "SELECT email FROM invitation_invitee WHERE invitation_id = ? AND kind = 'person'",
        vec![invitation.into()],
    )?
    .first()
    .map(|row| text(&row["email"])))
}

/// Erases the address of every person invitation that has ended or expired by `now`.
pub(super) fn erase_ended(sql: &SqlStorage, now: i64) -> R<()> {
    exec(
        sql,
        "UPDATE invitation_invitee SET email = NULL WHERE email IS NOT NULL AND invitation_id IN
           (SELECT id FROM invitation WHERE status <> 'pending' OR expires_at <= ?)",
        vec![now.into()],
    )
}

/// When the alarm should next erase an address: now for one that has ended, else the earliest expiry still holding one.
pub(super) fn next_erasure(sql: &SqlStorage) -> R<Option<i64>> {
    Ok(rows(
        sql,
        "SELECT min(CASE WHEN i.status <> 'pending' THEN 0 ELSE i.expires_at END) AS due
           FROM invitation_invitee p JOIN invitation i ON i.id = p.invitation_id WHERE p.email IS NOT NULL",
        vec![],
    )?
    .first()
    .and_then(|row| row["due"].as_i64()))
}

/// `POST invitations` with `invitee: { kind: "person", email }`. The owner or an admin, as a person. It answers the same
/// whether or not the address has an account, and the address goes nowhere but this room's row.
pub(super) fn create(
    sql: &SqlStorage,
    caller: &Caller,
    room: &str,
    body: &Value,
    now: i64,
) -> R<Value> {
    ApiError::from_verdict(authorize_workroom(caller, WorkroomAction::ManageAccess))?;
    require_policy_version(sql, body)?;
    let invitee = body["invitee"]
        .as_object()
        .ok_or_else(ApiError::invalid_argument)?;
    if invitee.keys().any(|k| k != "kind" && k != "email")
        || invitee.get("kind").and_then(Value::as_str) != Some("person")
    {
        return Err(ApiError::invalid_argument());
    }
    let email = invitee
        .get("email")
        .and_then(Value::as_str)
        .and_then(normalize_email)
        .ok_or_else(ApiError::invalid_argument)?;
    // A person invitation names no organization and no opening: it's for this one person.
    if !body["invited_org_id"].is_null() || !body["work_role_id"].is_null() {
        return Err(ApiError::invalid_argument());
    }
    let role = field(body, "role")?.unwrap_or_else(|| "guest".to_string());
    if !person_invitation_role_allowed(parse_role(&role)) {
        return Err(ApiError::invalid_argument());
    }
    let guest_can_create = guest_switch(&role, body, false)?;
    erase_ended(sql, now)?;
    // One pending invitation per address: a new one replaces it.
    let replaced = rows(
        sql,
        "SELECT i.id FROM invitation i JOIN invitation_invitee p ON p.invitation_id = i.id
           WHERE i.status = 'pending' AND i.expires_at > ? AND p.email = ?",
        vec![now.into(), email.as_str().into()],
    )?;
    for row in &replaced {
        let id = text(&row["id"]).unwrap_or_default();
        exec(
            sql,
            "UPDATE invitation SET status = 'withdrawn' WHERE id = ?",
            vec![id.as_str().into()],
        )?;
        let reason = json!({ "reason": "replaced" }).to_string();
        audit(
            sql,
            caller,
            "invitation.withdrawn",
            &id,
            None,
            Some(reason),
            now,
        )?;
    }
    erase_ended(sql, now)?;
    let counted = |query: &str, at: i64| -> R<i64> {
        Ok(rows(sql, query, vec![at.into()])?
            .first()
            .map_or(0, |row| int(&row["n"])))
    };
    let pending = counted(
        "SELECT count(*) AS n FROM invitation i JOIN invitation_invitee p ON p.invitation_id = i.id
           WHERE i.status = 'pending' AND i.expires_at > ?",
        now,
    )?;
    let today = counted(
        "SELECT count(*) AS n FROM invitation i JOIN invitation_invitee p ON p.invitation_id = i.id
           WHERE i.created_at > ?",
        now - DAY_MS,
    )?;
    if pending >= MAX_PENDING || today >= MAX_PER_DAY {
        return Err(ApiError::limit_exceeded());
    }
    let id = format!("ivt_{}", uuid::Uuid::new_v4().simple());
    let secret = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let expires_at = now + INVITATION_TTL_MS;
    exec(sql, "INSERT INTO invitation (id, work_role_id, invited_org_id, role, guest_can_create, token_hash, expires_at, status, created_by, created_at) VALUES (?, NULL, NULL, ?, ?, ?, ?, 'pending', ?, ?)", vec![
        id.as_str().into(), role.as_str().into(), flag(guest_can_create), invitation_hash(&secret).into(), expires_at.into(), caller.id.as_str().into(), now.into(),
    ])?;
    exec(
        sql,
        "INSERT INTO invitation_invitee (invitation_id, kind, email) VALUES (?, 'person', ?)",
        vec![id.as_str().into(), email.as_str().into()],
    )?;
    audit(
        sql,
        caller,
        "invitation.created",
        &id,
        None,
        Some(
            json!({ "invitee_kind": "person", "role": role, "guest_can_create": guest_can_create })
                .to_string(),
        ),
        now,
    )?;
    // The token is returned once, and `command` removes it from the idempotency record. The address isn't returned.
    Ok(json!({
        "id": id, "token": format!("inv_{room}.{id}.{secret}"), "invitee_kind": "person", "role": role,
        "guest_can_create": guest_can_create, "expires_at": expires_at,
    }))
}

/// Whether the signed-in person is the one this invitation is addressed to: their verified email, as the gateway stated
/// it, matches the address still on the invitation.
fn addressed_to(identity: &Identity, address: Option<&str>) -> bool {
    let verified = identity.verified_email.as_deref().and_then(normalize_email);
    identity.kind == "person" && address.is_some() && verified.as_deref() == address
}

/// The organizations the person may join as: those they belong to now, other than the room's, and none the room has
/// revoked since the invitation was made.
fn eligible_orgs(sql: &SqlStorage, identity: &Identity, invitation: &Value) -> R<Vec<String>> {
    let room_org = room_owner_org(sql)?;
    let mut orgs: Vec<String> = identity
        .orgs
        .iter()
        .chain([&identity.org])
        .filter(|org| **org != room_org)
        .cloned()
        .collect();
    orgs.sort();
    orgs.dedup();
    let mut eligible = Vec::new();
    for org in orgs {
        if !barred_by_revocation(sql, &org, invitation)? {
            eligible.push(org);
        }
    }
    Ok(eligible)
}

/// What a person invitation offers, for the person it's addressed to. Anyone else, an unverified email included, gets
/// `invitation_not_found` before anything about the room is read.
pub(super) fn preview(
    sql: &SqlStorage,
    identity: &Identity,
    invitation: &Value,
    address: Option<&str>,
) -> R<Value> {
    if !addressed_to(identity, address) {
        return Err(ApiError::invitation_not_found());
    }
    let room = rows(sql, "SELECT id, name FROM workspace", vec![])?;
    let room = room.first().ok_or_else(ApiError::invitation_not_found)?;
    let orgs = eligible_orgs(sql, identity, invitation)?;
    // Accepting gives up any oversight they have of their organizations' agents here, for good (decision 247), so the
    // page can say so. Only someone with no row here has any.
    let has_row = !rows(
        sql,
        "SELECT principal_id FROM member WHERE principal_id = ?",
        vec![identity.id.as_str().into()],
    )?
    .is_empty();
    let room_org = room_owner_org(sql)?;
    let mut ends_oversight = false;
    if !has_row {
        for org in identity.admin_orgs.iter().filter(|org| **org != room_org) {
            ends_oversight |= !rows(sql, "SELECT principal_id FROM member WHERE kind = 'agent' AND org_id = ? AND revoked_at IS NULL LIMIT 1", vec![org.as_str().into()])?.is_empty();
        }
    }
    Ok(json!({
        "workspace_id": room["id"], "workspace_name": room["name"], "invitee_kind": "person", "work_role": null,
        "role": invitation["role"], "guest_can_create": int(&invitation["guest_can_create"]) != 0,
        "invited_org_id": null, "invited_by": invitation["created_by"], "expires_at": invitation["expires_at"],
        "orgs": orgs, "ends_oversight": ends_oversight,
    }))
}

/// Accepts a person invitation, in the room's transaction: the person joins as the organization they chose. A retry of the
/// same request by the same person gets the first answer.
pub(super) fn accept(
    sql: &SqlStorage,
    identity: &Identity,
    id: &str,
    secret: &str,
    body: &Value,
    now: i64,
) -> R<Value> {
    let found =
        find_invitation(sql, id, secret, now)?.ok_or_else(ApiError::invitation_not_found)?;
    let Some(address) = invitee(sql, id)? else {
        return Err(ApiError::invitation_not_found());
    };
    // Who is asking comes first: someone the link isn't addressed to learns nothing from how their request is formed.
    let request = json!({ "org_id": body["org_id"] }).to_string();
    if found["status"].as_str() == Some("accepted") {
        if found["accepted_by"].as_str() == Some(identity.id.as_str())
            && found["accepted_request"].as_str() == Some(request.as_str())
        {
            return Ok(serde_json::from_str(
                found["accepted_response"].as_str().unwrap_or("null"),
            )?);
        }
        return Err(ApiError::invitation_not_found());
    }
    if !addressed_to(identity, address.as_deref()) {
        return Err(ApiError::invitation_not_found());
    }
    let org = required(body, "org_id")?;
    // A person invitation brings in the person only.
    if body.get("agents").is_some() {
        return Err(ApiError::invalid_argument());
    }
    require_id(&org)?;
    // People of the room's organization are added directly (decision 245).
    if org == room_owner_org(sql)? {
        return Err(ApiError::invalid_argument());
    }
    if !in_org(identity, &org) {
        return Err(ApiError::not_allowed());
    }
    if barred_by_revocation(sql, &org, &found)? {
        return Err(ApiError::invitation_not_found());
    }
    if is_owner(sql, &identity.id)? {
        return Err(ApiError::already_member());
    }
    let created_by = text(&found["created_by"]).unwrap_or_default();
    let existing = rows(
        sql,
        "SELECT kind, org_id, revoked_at, added_at FROM member WHERE principal_id = ?",
        vec![identity.id.as_str().into()],
    )?;
    let prior = existing.first();
    if let Some(prior) = prior {
        let held = text(&prior["org_id"]).unwrap_or_default();
        // A place held through an organization they've since left, or rejoined, has already ended.
        let ended = !in_org(identity, &held)
            || identity
                .org_since
                .get(&held)
                .is_some_and(|since| *since > int(&prior["added_at"]));
        if prior["revoked_at"].is_null() && !ended {
            return Err(ApiError::already_member());
        }
        // Correcting a revoked participant's identity is the owner's alone (decision 246): an admin's invitation can't
        // bring them back as someone else.
        if (prior["kind"].as_str() != Some("person") || held != org) && !is_owner(sql, &created_by)?
        {
            return Err(ApiError::not_allowed());
        }
    }
    if active_count(sql)? + 1 >= MAX_MEMBERS {
        return Err(ApiError::limit_exceeded());
    }
    let role = text(&found["role"]).unwrap_or_else(|| "guest".to_string());
    // Checked again, so a row written before this rule can't make an admin.
    if !person_invitation_role_allowed(parse_role(&role)) {
        return Err(ApiError::invitation_not_found());
    }
    let guest_can_create = role == "guest" && int(&found["guest_can_create"]) != 0;
    let prior_json = prior.map(|p| {
        json!({ "kind": p["kind"], "org_id": p["org_id"], "revoked": !p["revoked_at"].is_null() }).to_string()
    });
    // The gateway's clock may be ahead, and the row mustn't look older than the membership it rests on.
    let added_at = identity
        .org_since
        .get(&org)
        .map_or(now, |since| now.max(*since));
    write_member(
        sql,
        &created_by,
        &identity.id,
        "person",
        &org,
        &role,
        guest_can_create,
        None,
        added_at,
    )?;
    let actor = Caller {
        id: identity.id.clone(),
        kind: PrincipalKind::Person,
        role: Role::None,
        scopes: Scopes::PUBLIC_PARTICIPANT,
    };
    let scopes = Scopes::for_role(parse_role(&role), guest_can_create);
    audit(
        sql,
        &actor,
        "member.added",
        &identity.id,
        prior_json,
        Some(
            json!({ "role": role, "kind": "person", "org_id": org, "guest_can_create": guest_can_create, "invitation": id,
                "access": access_json(PrincipalKind::Person, parse_role(&role), scopes) })
            .to_string(),
        ),
        now,
    )?;
    audit(
        sql,
        &actor,
        "invitation.accept",
        id,
        None,
        Some(
            json!({ "invitee_kind": "person", "principal_id": identity.id, "org_id": org })
                .to_string(),
        ),
        now,
    )?;
    // The person's inbox, so the room shows up for them, and the inviter's, so they know it was accepted.
    let mut recipients = vec![identity.id.clone()];
    if created_by != identity.id {
        recipients.push(created_by.clone());
    }
    store::record_event_about(
        sql,
        "member.added",
        &identity.id,
        Some(&identity.id),
        None,
        &Transition::NONE,
        recipients,
        now,
    )?;
    let response =
        json!({ "status": "accepted", "principal_id": identity.id, "org_id": org, "role": role });
    exec(sql, "UPDATE invitation SET status = 'accepted', accepted_by = ?, accepted_request = ?, accepted_response = ? WHERE id = ?",
        vec![identity.id.as_str().into(), request.as_str().into(), response.to_string().into(), id.into()])?;
    erase_ended(sql, now)?;
    Ok(response)
}

/// `POST leave`: a person leaves the room on their own (decision 239). It ends their own row only, with the departure
/// rules, and gives back nothing: an organization admin's oversight of its agents here doesn't return (decision 247),
/// because their row stays as a revoked one. The owner transfers ownership first.
pub(super) fn leave(sql: &SqlStorage, caller: &Caller, now: i64) -> R<Value> {
    ApiError::from_verdict(authorize_workroom(caller, WorkroomAction::LeaveRoom))?;
    remove_member(sql, caller, "person", &caller.id, "person_left", now)?;
    Ok(json!({ "principal_id": caller.id, "status": "left" }))
}
