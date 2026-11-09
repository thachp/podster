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

/// `{ suspended, reason, operator }`: suspends or lifts, audited as the operator, with an event that marks the index row
/// due and tells the room's managers. Doing what's already so changes nothing. Answers `{ suspended, reason, at }`.
pub(super) fn set(sql: &SqlStorage, body: &Value, now: i64) -> R<Value> {
    let suspended = body["suspended"]
        .as_bool()
        .ok_or_else(ApiError::invalid_argument)?;
    let reason = body["reason"]
        .as_str()
        .and_then(podster_policy::moderation::Reason::from_name)
        .ok_or_else(ApiError::invalid_argument)?;
    let operator = body["operator"]
        .as_str()
        .filter(|id| crate::valid_id(id))
        .ok_or_else(ApiError::invalid_argument)?;
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
            operator,
            "person",
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
            operator,
            None,
            &Transition::NONE,
            roles::room_managers(sql, operator)?,
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
