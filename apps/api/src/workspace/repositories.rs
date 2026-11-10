//! Managed repositories: the room's state for M5 (ADR 0009, which is proposed), as far as step 2 goes.
//!
//! The room owns five tables: `repo_request` and its `repo_request_attempt`s, `repo_link`, `provider_grant` and `task_change`. Nothing writes them yet.
//! Provisioning is step 4, tokens step 6, merge step 7 and the status read step 8, so this module only reads the request
//! and the link, and refuses the three task routes. No call to GitHub is made from here, and no token exists.
//!
//! What a later step can rely on: a route here never takes an organization, an installation, a repository or a pull
//! request from the caller. The repository is the room's `repo_link`, and only a `ready` one allows any work.
use super::*;
use podster_core::repositories::{link_allows_work, valid_commit_sha, LinkStatus, REPO_NOT_READY};

/// What the three task routes answer in a room whose link is ready, until the steps that build them land. No room can
/// reach it through the API yet, because nothing creates a link.
const NOT_BUILT: &str = "managed_repositories_unavailable";

/// The room's link status, or `None` for no link. A stored status this code can't read is `None` too, so it refuses.
fn link_status(sql: &SqlStorage) -> R<Option<LinkStatus>> {
    Ok(rows(sql, "SELECT status FROM repo_link", vec![])?
        .first()
        .and_then(|row| row["status"].as_str().and_then(LinkStatus::from_name)))
}

/// `GET repository`: the room's request for a repository and its linked repository, each null if there's none. For
/// a person who sees the whole room, never an agent: the contract lists it as person-only, and an agent learns of the
/// repository through `get_repo_access`. It's a read of current state and authorizes nothing.
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

/// The only fields `merge_task` takes. The pull request comes from the task's `task_change`, never from the caller.
pub(super) const MERGE_FIELDS: &[&str] = &["submission_no", "commit_sha"];

/// What `get_repo_access`, `merge_task` and `get_task_release_status` answer for now. Authority comes first: a task the
/// caller can't see answers as a missing one, whatever the room's repository is and whatever was sent. Then the request's
/// shape: any field outside `fields` is refused, so an organization, installation, repository or pull request a client
/// names is never read (M5-04), and a merge must name its submission and commit. Then the room's own state decides:
/// `repo_not_ready` without a ready link, and otherwise that the work isn't available yet. Nothing is written and
/// nothing leaves the room.
pub(super) fn refuse_task_route(
    sql: &SqlStorage,
    who: &Participant,
    task_id: &str,
    fields: &[&str],
    body: &Value,
) -> R<Value> {
    let task = load_task(sql, task_id)?.ok_or_else(ApiError::task_not_found)?;
    ApiError::from_verdict(authorize_task(&who.caller, &task, TaskAction::Read))?;
    let sent = body.as_object().ok_or_else(ApiError::invalid_argument)?;
    if sent.keys().any(|key| !fields.contains(&key.as_str())) {
        return Err(ApiError::invalid_argument());
    }
    if !fields.is_empty() {
        let numbered = body["submission_no"].as_u64().is_some_and(|n| n >= 1);
        let commit = body["commit_sha"].as_str().is_some_and(valid_commit_sha);
        if !numbered || !commit {
            return Err(ApiError::invalid_argument());
        }
    }
    if !link_allows_work(link_status(sql)?) {
        return Err(ApiError::api(409, REPO_NOT_READY));
    }
    Err(ApiError::api(501, NOT_BUILT))
}
