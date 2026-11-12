//! An operator's suspension of the room's public surface (M4 step 10, decision 158). It works like unpublishing without
//! changing the room's own setting: the room answers not-found publicly, its index row stops being resolvable, public
//! claims are refused, and the owner can't publish again until an operator lifts it. The owner can still make it private.
//! Nothing else about the room changes: an operator can't read it, end claims or change access.
use super::*;

/// The Worker's call, for a verified operator. Nothing outside the Worker reaches it.
pub(crate) const INTERNAL_SUSPENSION: &str = "/internal/operator-suspension";

/// The suspension now, for the owner's view: `{ reason, at }`, or null.
pub(super) fn suspension(sql: &SqlStorage) -> R<Value> {
    Ok(rows(
        sql,
        "SELECT suspended_at, suspension_reason FROM workspace WHERE suspended_at IS NOT NULL",
        vec![],
    )?
    .first()
    .map_or(
        Value::Null,
        |row| json!({ "reason": row["suspension_reason"], "at": row["suspended_at"] }),
    ))
}

/// Who the room records for an operator's action. The owner sees "Suspended by Podster" (decision 158), so the operator's
/// own ID stays in the `Moderation` object's log and never reaches the room's events, inbox or audit.
pub(super) const PODSTER: &str = "podster";
pub(super) const PODSTER_KIND: &str = "system";

/// `{ suspended, reason, handle? }`: suspends or lifts, audited as Podster, with an event that marks the index row due and
/// tells the room's managers. With `handle`, the room acts only if it's the room's handle now or its last published one, so
/// an index row can't point an operator at the wrong room; an action from a report names the room itself and sends none.
/// Doing what's already so changes nothing. Answers `{ suspended, reason, at }`.
pub(super) fn set(sql: &SqlStorage, body: &Value, now: i64) -> R<Value> {
    let suspended = body["suspended"]
        .as_bool()
        .ok_or_else(ApiError::invalid_argument)?;
    let reason = body["reason"]
        .as_str()
        .and_then(podster_policy::moderation::Reason::from_name)
        .ok_or_else(ApiError::invalid_argument)?;
    if let Some(handle) = body.get("handle").filter(|h| !h.is_null()) {
        let handle = handle.as_str().ok_or_else(ApiError::invalid_argument)?;
        let current = rows(sql, "SELECT public_handle FROM workspace", vec![])?
            .first()
            .and_then(|row| text(&row["public_handle"]));
        let last = super::visibility::last_published_handle(sql)?;
        if current.as_deref() != Some(handle) && last.as_deref() != Some(handle) {
            return Err(ApiError::workspace_not_found());
        }
    }
    let prior = suspension(sql)?;
    if prior.is_null() == suspended {
        if suspended {
            exec(
                sql,
                "UPDATE workspace SET suspended_at = ?, suspension_reason = ?",
                vec![now.into(), reason.name().into()],
            )?;
        } else {
            exec(
                sql,
                "UPDATE workspace SET suspended_at = NULL, suspension_reason = NULL",
                vec![],
            )?;
        }
        audit_as(
            sql,
            PODSTER,
            PODSTER_KIND,
            if suspended {
                "room.suspended"
            } else {
                "room.suspension_lifted"
            },
            "workspace",
            Some(json!({ "suspended": !prior.is_null() }).to_string()),
            Some(json!({ "suspended": suspended, "reason": reason.name() }).to_string()),
            now,
        )?;
        record_event(
            sql,
            if suspended {
                "room.suspended"
            } else {
                "room.suspension_lifted"
            },
            PODSTER,
            None,
            &Transition::NONE,
            roles::room_managers(sql, PODSTER)?,
            now,
        )?;
    }
    let after = suspension(sql)?;
    Ok(json!({
        "suspended": !after.is_null(),
        "reason": after["reason"],
        "at": after["at"],
    }))
}
