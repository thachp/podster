//! The room's side of `/v1/preview-access` (M8 step 7; the preview plan, `docs/m8-preview-plan.md`, 5.3 to 5.7;
//! decisions 252, 255 and 258), and the access epoch's raises (the plan's 5.6).
//!
//! **Who gets a ticket is decided here, from the room's own state alone** (`podster_policy::preview::decide_access`):
//! the label the Worker routed by must be the room's current preview label, the preview must exist and not be
//! suspended or held, and the caller must pass `may_view` now, as they were resolved against the gateway's assertion.
//! Every refusal is one answer, `preview_access_refused` (404), so nothing tells which hosts exist or who may see them.
//!
//! **One person's 60 an hour in the room** (`person_in_room_allowed`, counted from the person's `preview_session` rows)
//! and then **the room's 300 an hour** (`room_access_allowed`) count asks that passed the access check, and are asked
//! only after it, so no one viewer can spend the room's hour: an ask that would be refused anyway never
//! counts, so nobody outside the room can spend its hour, and a person who may not view is never told the room is busy.
//! Every ask, granted or not, has already been counted against the person's 30 a minute in their own `Principal`.
//!
//! **On a grant**, in one transaction: the ask counted; a `preview_session` row (its ID, the person, made now, ending an
//! hour on); and a ticket and a session token signed with the owner's key over the same host, slot, session, epoch and
//! state hash (`podster_core::preview_access::ticket_claims` and `session_claims`). No person ID is in either. Expired
//! sessions and asks past the hour are pruned in the same transaction, so neither table grows without bound.
//!
//! **Revocation** ([`raise_epoch`]): whenever who may view can shrink, the room raises the slot's access epoch in the
//! same transaction as the change, and owes every preview host its entry again so the applier writes the new epoch. Told as `preview.access_revoked` with the reason's code, IDs only.
//!
//! **Nothing here is logged:** no host, label, ticket, session, state hash or person.
use super::*;
use podster_core::preview::{EpochRaise, PreviewDeleteTrigger};
use podster_core::preview_access::{
    enter_location, person_in_room_allowed, person_in_room_retry_after_ms, room_access_allowed,
    room_retry_after_ms, session_claims, signing_input, ticket_claims, token, token_payload,
    Claims, TokenAsk, PER_ROOM_WINDOW_MS, SESSION_ID_PREFIX, SESSION_MAX_TTL_MS,
};
use podster_core::release::window_start;
use podster_egress::preview_key::PreviewKey;
use podster_policy::preview::{decide_access, AccessFacts, ViewStanding};

/// The Worker's call into the room for `/v1/preview-access`, with the caller's identity and `{ label, st, r }`.
pub(crate) const INTERNAL_PREVIEW_ACCESS: &str = "/internal/preview-access";

/// The one answer to every refusal (the plan's 5.3, step 3).
pub(crate) fn refused() -> ApiError {
    // error-codes: preview_access_refused
    ApiError::api(404, "preview_access_refused")
}

/// What the room was asked, as the Worker checked its forms.
pub(super) struct Ask {
    pub(super) label: String,
    pub(super) state_hash: String,
    pub(super) r: String,
}

/// A new session's ID: `pvs_` and 32 hexadecimal characters drawn at random.
fn new_session_id() -> String {
    format!("{SESSION_ID_PREFIX}{}", uuid::Uuid::new_v4().simple())
}

/// Signs one token's claims with the owner's key. `None` for claims core won't give a payload, so nothing malformed is
/// ever signed.
fn signed(key: &PreviewKey, claims: &Claims) -> Option<String> {
    let payload = token_payload(claims)?;
    Some(token(
        &payload,
        &key.sign(signing_input(&payload).as_bytes()),
    ))
}

/// **Decides and, on a grant, records and signs**, in the caller's transaction (see the module's notes). Answers
/// `{ redirect }`.
pub(super) fn grant(
    sql: &SqlStorage,
    identity: &Identity,
    previews: podster_core::preview::DeploymentPreviews,
    key: &PreviewKey,
    domain: &str,
    ask: &Ask,
    now: i64,
) -> R<Value> {
    // Anyone the room doesn't know, or whose place no longer holds, is refused the same way as everyone else.
    let who = resolve_caller(sql, identity).map_err(|_| refused())?;
    let stored = preview::current(sql)?;
    let slot = stored.as_ref().map(|stored| &stored.slot);
    let label_row = rows(
        sql,
        "SELECT kind, retired_at, suspended_at FROM app_label WHERE label = ?",
        vec![ask.label.as_str().into()],
    )?;
    let label_live_preview = label_row
        .first()
        .is_some_and(|row| row["kind"].as_str() == Some("preview") && row["retired_at"].is_null());
    let facts = AccessFacts {
        host_is_rooms_preview_host: label_live_preview
            && slot.is_some_and(|slot| slot.label() == ask.label),
        preview_exists: slot.is_some(),
        preview_suspended: label_row
            .first()
            .is_some_and(|row| !row["suspended_at"].is_null())
            || takedown::app_suspended(sql)?
            || releasers::hold_state(sql)?.0,
    };
    let standing = ViewStanding {
        through_public_claim: public_claims::is_public_participant(sql, &who.caller.id)?,
        place_holds: true,
    };
    decide_access(previews, &who.caller, standing, facts).map_err(|refusal| {
        if refusal == podster_policy::preview::PreviewAccessRefusal::PreviewsOff {
            ApiError::not_found()
        } else {
            refused()
        }
    })?;
    let slot = slot.ok_or_else(refused)?;

    // Only now the room's hour: asks older than it go, and the rest are counted.
    let start = window_start(now, PER_ROOM_WINDOW_MS);
    exec(
        sql,
        "DELETE FROM preview_access_ask WHERE at < ?",
        vec![start.into()],
    )?;
    exec(
        sql,
        "DELETE FROM preview_session WHERE expires_at <= ?",
        vec![now.into()],
    )?;
    let asked: Vec<i64> = rows(sql, "SELECT at FROM preview_access_ask", vec![])?
        .iter()
        .filter_map(|row| row["at"].as_i64())
        .collect();
    // One person's share first, from the room's own session rows: no one viewer can spend the room's hour.
    let given: Vec<i64> = rows(
        sql,
        "SELECT created_at FROM preview_session WHERE person_id = ?",
        vec![who.caller.id.as_str().into()],
    )?
    .iter()
    .filter_map(|row| row["created_at"].as_i64())
    .collect();
    if person_in_room_allowed(&given, now).is_err() {
        let wait_ms = person_in_room_retry_after_ms(&given, now).unwrap_or(1000);
        // error-codes: preview_access_limit
        return Err(ApiError::api(429, "preview_access_limit")
            .retry_after(wait_ms.saturating_add(999) / 1000));
    }
    if room_access_allowed(&asked, now).is_err() {
        let wait_ms = room_retry_after_ms(&asked, now).unwrap_or(1000);
        // error-codes: preview_access_limit
        return Err(ApiError::api(429, "preview_access_limit")
            .retry_after(wait_ms.saturating_add(999) / 1000));
    }

    let host = format!("{}.{domain}", slot.label());
    let session = new_session_id();
    let token_ask = TokenAsk {
        kid: key.kid(),
        host: &host,
        slot: slot.id(),
        session: &session,
        epoch: slot.access_epoch(),
        state_hash: &ask.state_hash,
        now,
    };
    let ticket = ticket_claims(&token_ask)
        .ok()
        .and_then(|claims| signed(key, &claims));
    let session_token = session_claims(&token_ask)
        .ok()
        .and_then(|claims| signed(key, &claims));
    let (Some(ticket), Some(session_token)) = (ticket, session_token) else {
        return Err(ApiError::internal("a preview token core wouldn't form"));
    };
    let redirect = enter_location(&host, &ticket, &session_token, &ask.r)
        .ok_or_else(|| ApiError::internal("a preview location core wouldn't form"))?;
    exec(
        sql,
        "INSERT INTO preview_access_ask (at) VALUES (?)",
        vec![now.into()],
    )?;
    exec(
        sql,
        "INSERT INTO preview_session (sid, person_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
        vec![
            session.as_str().into(),
            who.caller.id.as_str().into(),
            now.into(),
            now.saturating_add(SESSION_MAX_TTL_MS).into(),
        ],
    )?;
    Ok(json!({ "redirect": redirect }))
}

/// **Raises the preview's access epoch**, in the caller's transaction, because who may view it can have shrunk (the
/// plan's 5.6): the slot written one epoch higher; every one of its hosts owed its entry again at once, so the applier
/// writes the new epoch and the content Worker refuses every ticket and session signed before. The session rows stay
/// until their hour ends, since each person's share of the room's hour is counted from them. Told as `preview.access_revoked` to the room's owner and its admins who are people, with the reason's code
/// and nothing else. A room with no preview has nothing to raise. At the epoch's ceiling, which no room reaches in
/// practice, revocation can't be written, so the preview is deleted instead, which takes every host down.
pub(super) fn raise_epoch(
    sql: &SqlStorage,
    reason: EpochRaise,
    actor: &str,
    actor_kind: &str,
    now: i64,
) -> R<()> {
    let Some(stored) = preview::current(sql)? else {
        return Ok(());
    };
    let Ok(raised) = stored.slot.raise_access_epoch() else {
        preview::delete_for(sql, PreviewDeleteTrigger::Requested, actor, actor_kind, now)?;
        return Ok(());
    };
    preview::write(sql, &raised, now)?;
    exec(
        sql,
        "UPDATE preview_apply SET attempts = 0, next_attempt_at = NULL, updated_at = ? WHERE slot_id = ?",
        vec![now.into(), raised.id().into()],
    )?;
    store::record_event_about(
        sql,
        "preview.access_revoked",
        actor,
        Some(raised.id()),
        None,
        &Transition {
            reason: Some(reason.code()),
            ..Transition::NONE
        },
        preview::told(sql, actor)?,
        now,
    )
}

/// [`raise_epoch`] when a principal lost their place or part of it: only for a person, since an agent never views.
pub(super) fn raise_for(
    sql: &SqlStorage,
    principal_kind: Option<&str>,
    reason: EpochRaise,
    actor: &str,
    actor_kind: &str,
    now: i64,
) -> R<()> {
    if principal_kind == Some("person") {
        raise_epoch(sql, reason, actor, actor_kind, now)?;
    }
    Ok(())
}
