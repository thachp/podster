//! Managed repositories: the room's state for M5 (ADR 0009, which is proposed), as far as step 2 goes.
//!
//! The room owns five tables: `repo_request` and its `repo_request_attempt`s, `repo_link`, `provider_grant` and
//! `task_change`. Nothing writes them yet: provisioning is step 4. This module only reads the request and the link, for a
//! person. `get_repo_access`, `merge_task` and `get_task_release_status` have no route here. Each arrives with the step
//! that builds it, so no agent sees a merge tool before the merge path and its checks exist (AC-17).
use super::*;

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
