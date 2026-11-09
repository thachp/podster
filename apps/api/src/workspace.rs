//! The Workspace Durable Object: the single writer and authority for one room.
//! Commands run in one transaction: policy, then core, then state, events, outbox and idempotency. Queries only read.
//! The alarm delivers the outbox to each recipient's Principal.

use crate::error::ApiError;
use crate::principal;
use crate::store::{
    self, exec, flag, int, load_task, opt, participant, record_decision, record_event, rows,
    save_task, text, transaction_sync, Transition,
};
use crate::{
    Caller as Verified, AGENT_ID_PREFIX, CALLER_HEADER, INTERNAL_ACCEPT_PATH, INTERNAL_INIT_PATH,
    INTERNAL_PREVIEW_PATH,
};
use podster_assertion::TargetMember;
use podster_core::{
    apply_departure, apply_review_ended, decide, decide_claim, decide_create, validate_brief,
    validate_planned_relationship, validate_role, Artifact, ClaimOutcome, ClaimRefusal, ClaimState,
    Command, HandoffKind, NewTask, Observed, Task, TaskPatch, TaskStatus, MAX_MESSAGE_BYTES,
};
use podster_policy::{
    authorize_requester_change, authorize_reviewer_change, authorize_task, authorize_workroom,
    can_review, can_see_event, can_see_task, denied_change_name, effective_scopes,
    is_authority_refusal, may_claim_role, may_decide_review, may_recover_ownership,
    org_departure_ends, owner_authority_holds, reads_every_thread, scopes_after_claim,
    sees_notices_about_itself, sees_planned_relationships, sees_who_planned, sees_whole_plan,
    sees_whole_room, task_view, ArtifactScope, ArtifactView, Caller, ConversationScope, Preset,
    PrincipalKind, ReviewScope, Role, Scopes, TaskAction, TaskScope, Verdict, WorkroomAction,
    EVENTS_FOR_EVERYONE,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{cell::RefCell, rc::Rc};
use wasm_bindgen::JsValue;
use worker::{SqlStorageValue as V, *};

type R<T> = std::result::Result<T, ApiError>;

const IDEMPOTENCY_TTL_MS: i64 = 7 * 24 * 60 * 60 * 1000;
const PAGE_SIZE: i64 = 50;
const OUTBOX_BATCH: i64 = 50;
const OUTBOX_MAX_BACKOFF_MS: i64 = 5 * 60 * 1000;
const OUTBOX_RETRY_MS: i64 = 5000;
// Long enough for a busy recipient, short enough that a stuck one doesn't hold up the rest of the room.
const DELIVERY_TIMEOUT_MS: u64 = if cfg!(feature = "failpoints") {
    300
} else {
    10_000
};
const INVITATIONS_LISTED: i64 = 200;
const DENIAL_ROWS: i64 = 5000;
/// Different refusals held in memory before they're written. Past this, a new actor counts as an outsider's refusal, and
/// the outsider's own keys are bounded by the lists of actions and codes, so this stays under about 1,000 keys. Around 21
/// busy actors can fill it and lose attribution until the next flush a few seconds later, which is accepted: counts stay
/// right, and only who is named changes.
const DENIALS_HELD: usize = 512;
const DENIAL_FLUSH_SECS: u64 = 5;
const DENIALS_PAGE: i64 = 100;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;
/// Everyone who isn't and never was in the room shares one row, so new identities can't make new rows.
const OUTSIDER: &str = "outsider";
const REMOVED_LISTED: i64 = 200;
const ARCHIVED: &str = "archived";
const ACTIVE_ROOM: &str = "active";
const MAX_MEMBERS: i64 = 50;
const MAX_OPEN_TASKS: i64 = 1000;
const MAX_NAME_BYTES: usize = 200;
const MAX_KEY_BYTES: usize = 255;
const MAX_ACCEPT_AGENTS: usize = 20;
const ACTIVITY_PAGE: i64 = 50;
const INVITATION_TTL_MS: i64 = 7 * 24 * 60 * 60 * 1000;

type Identity = Verified;

mod a2a_out;
mod asset_links;
mod collaboration;
mod cursor;
mod downloads;
mod held;
mod objects;
mod outputs;
mod plan;
mod planned;
mod removal;
mod roles;
mod submission_files;

/// The caller as this room knows them. `org` comes from stored state, not the request.
struct Participant {
    caller: Caller,
    org: String,
}

fn parse_kind(kind: &str) -> PrincipalKind {
    if kind == "person" {
        PrincipalKind::Person
    } else {
        PrincipalKind::Agent
    }
}

/// An agent's ID says it's an agent, as `handle_add_member` requires.
fn parse_kind_of(principal: &str) -> PrincipalKind {
    if principal.starts_with(AGENT_ID_PREFIX) {
        PrincipalKind::Agent
    } else {
        PrincipalKind::Person
    }
}

fn parse_role(role: &str) -> Role {
    match role {
        "owner" => Role::Owner,
        "admin" => Role::Admin,
        "member" => Role::Member,
        "guest" => Role::Guest,
        _ => Role::None,
    }
}

/// Whether the caller may act in the organization this room recorded for them.
fn in_org(identity: &Identity, org: &str) -> bool {
    identity.org == org || (identity.kind == "person" && identity.orgs.iter().any(|o| o == org))
}

/// What an admin of an invited organization sees of its agent here: only the tasks it's party to, and never more of
/// them than the agent itself can read. It gives them no role in the room, and it ends when the agent is no longer in the room. It's not
/// for the room's own organization, whose people are in the room or were left out of it by its owner, and it's not for
/// someone already in the room or revoked from it, who have their own answers.
fn oversight_view(sql: &SqlStorage, identity: &Identity, agent: &str) -> R<Option<Participant>> {
    if identity.kind != "person" {
        return Ok(None);
    }
    let found = rows(
        sql,
        "SELECT org_id FROM member WHERE principal_id = ? AND kind = 'agent' AND revoked_at IS NULL",
        vec![agent.into()],
    )?;
    let Some(org) = found.first().and_then(|member| text(&member["org_id"])) else {
        return Ok(None);
    };
    if !identity.admin_orgs.contains(&org) || org == room_owner_org(sql)? {
        return Ok(None);
    }
    // Anyone with a row here, current or revoked, and the owner, answer from their own place in the room.
    let in_room = rows(
        sql,
        "SELECT principal_id FROM member WHERE principal_id = ?",
        vec![identity.id.as_str().into()],
    )?;
    if !in_room.is_empty() || is_owner(sql, &identity.id)? {
        return Ok(None);
    }
    Ok(Some(Participant {
        caller: Caller {
            id: agent.to_string(),
            kind: PrincipalKind::Agent,
            role: Role::Guest,
            scopes: store::granted_scopes(sql, agent)?.for_oversight(),
        },
        org,
    }))
}

fn write_denials(sql: &SqlStorage, held: &HeldDenials) -> R<()> {
    {
        // Oldest first, so a shared row's first and last actors come out right, up to refusals in the same millisecond.
        let mut ordered: Vec<(&DenialKey, &HeldDenial)> = held.iter().collect();
        ordered.sort_by_key(|(_, denial)| (denial.last_at, denial.first_at));
        for (key, denial) in ordered {
            let known = is_owner(sql, &key.actor)?
                || !rows(
                    sql,
                    "SELECT principal_id FROM member WHERE principal_id = ?",
                    vec![key.actor.as_str().into()],
                )?
                .is_empty();
            let who = if known { key.actor.as_str() } else { OUTSIDER };
            let day = denial.last_at / DAY_MS;
            exec(sql, "INSERT INTO denial (day, actor_id, actor_kind, action, code, count, first_at, last_at, first_actor_id, last_actor_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT (day, actor_id, actor_kind, action, code) DO UPDATE SET count = count + excluded.count, first_at = MIN(first_at, excluded.first_at), last_at = MAX(last_at, excluded.last_at), last_actor_id = excluded.last_actor_id", vec![
                day.into(), who.into(), key.kind.as_str().into(), key.action.into(), key.code.into(), denial.count.into(), denial.first_at.into(), denial.last_at.into(), key.actor.as_str().into(), key.actor.as_str().into(),
            ])?;
        }
        let total = rows(sql, "SELECT count(*) AS n FROM denial", vec![])?
            .first()
            .map_or(0, |row| int(&row["n"]));
        for _ in 0..(total - DENIAL_ROWS).max(0) {
            let largest = rows(sql, "SELECT actor_id FROM denial GROUP BY actor_id ORDER BY count(*) DESC, actor_id LIMIT 1", vec![])?;
            let Some(largest) = largest.first().and_then(|row| text(&row["actor_id"])) else {
                break;
            };
            exec(sql, "DELETE FROM denial WHERE rowid = (SELECT rowid FROM denial WHERE actor_id = ? ORDER BY last_at, rowid LIMIT 1)", vec![largest.as_str().into()])?;
        }
        Ok(())
    }
}

/// Reads the caller's current authority. Assertions and read models never supply a role.
///
/// A person's place here comes only from being its owner or from their own member row (decision 7). What their
/// organization's agents can see gives them nothing, and read-only oversight is the separate `oversight_view`.
fn resolve_caller(sql: &SqlStorage, identity: &Identity) -> R<Participant> {
    let room = rows(
        sql,
        "SELECT owner_person_id, owner_org_id, owner_left_at, owner_since FROM workspace",
        vec![],
    )?;
    let room = room.first().ok_or_else(ApiError::workspace_not_found)?;
    let kind = parse_kind(&identity.kind);
    if kind == PrincipalKind::Person
        && room["owner_person_id"].as_str() == Some(identity.id.as_str())
        && room["owner_org_id"]
            .as_str()
            .is_some_and(|org| in_org(identity, org))
        && owner_authority_holds(
            room["owner_left_at"].as_i64(),
            room["owner_since"].as_i64(),
            room["owner_org_id"]
                .as_str()
                .and_then(|org| identity.org_since.get(org).copied()),
        )
    {
        return Ok(Participant {
            caller: Caller {
                id: identity.id.clone(),
                kind,
                role: Role::Owner,
                scopes: Scopes::PUBLIC_PARTICIPANT,
            },
            org: text(&room["owner_org_id"]).unwrap_or_default(),
        });
    }
    let member = rows(
        sql,
        "SELECT kind, org_id, role, revoked_at, added_at FROM member WHERE principal_id = ?",
        vec![identity.id.as_str().into()],
    )?;
    let Some(member) = member.first() else {
        return Err(ApiError::workspace_not_found());
    };
    // An identity that doesn't match the stored one learns nothing, including whether it was revoked.
    let org = text(&member["org_id"]).unwrap_or_default();
    if member["kind"].as_str() != Some(identity.kind.as_str()) || !in_org(identity, &org) {
        return Err(ApiError::workspace_not_found());
    }
    // A role given before the person's current membership began ended when they left. Rejoining doesn't restore it.
    if kind == PrincipalKind::Person
        && identity
            .org_since
            .get(&org)
            .is_some_and(|since| *since > int(&member["added_at"]))
    {
        return Err(ApiError::workspace_not_found());
    }
    // The fence is checked in the room's own transaction, so it orders against every command here.
    if kind == PrincipalKind::Agent {
        let fence = rows(
            sql,
            "SELECT min_generation FROM principal_fence WHERE principal_id = ?",
            vec![identity.id.as_str().into()],
        )?;
        let floor = fence.first().map_or(0, |f| int(&f["min_generation"]));
        if identity.gen.is_none_or(|g| (g as i64) < floor) {
            return Err(ApiError::agent_disconnected());
        }
    }
    if !member["revoked_at"].is_null() {
        return Err(ApiError::access_revoked());
    }
    Ok(Participant {
        caller: Caller {
            id: identity.id.clone(),
            kind,
            role: member["role"].as_str().map_or(Role::None, parse_role),
            scopes: store::granted_scopes(sql, &identity.id)?,
        },
        org,
    })
}

/// Whether someone could be named reviewer now, under the room's person setting (decision 5).
fn eligible_reviewer(sql: &SqlStorage, id: &str) -> R<bool> {
    Ok(match participant(sql, id)? {
        Some((kind, role)) => can_review(
            parse_kind(&kind),
            parse_role(&role),
            store::granted_scopes(sql, id)?,
            store::requires_person_review(sql)?,
        ),
        None => false,
    })
}

fn require_eligible_reviewer(sql: &SqlStorage, id: &str) -> R<()> {
    if eligible_reviewer(sql, id)? {
        Ok(())
    } else {
        Err(ApiError::invalid_argument())
    }
}

fn require_participant(sql: &SqlStorage, id: &str) -> R<()> {
    participant(sql, id)?
        .map(|_| ())
        .ok_or_else(ApiError::invalid_argument)
}

fn now_ms() -> i64 {
    Date::now().as_millis() as i64
}

fn task_json(t: &Task) -> Value {
    json!({
        "id": t.id, "title": t.title, "instructions": t.instructions, "acceptance_criteria": t.acceptance_criteria,
        "requester": t.requester, "assignee": t.assignee, "reviewer": t.reviewer, "status": t.status.name(), "version": t.version,
        "due_at": t.due_at, "follow_up_of": t.follow_up_of, "submission_no": t.submission_no, "approved_submission_no": t.approved_submission_no, "needs_attention": t.needs_attention(),
    })
}

/// An optional string. A present field of the wrong type is an error, never silently ignored.
fn field(body: &Value, name: &str) -> R<Option<String>> {
    match body.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        Some(_) => Err(ApiError::invalid_argument()),
    }
}

fn int_field(body: &Value, name: &str) -> R<Option<i64>> {
    match body.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => v.as_i64().map(Some).ok_or_else(ApiError::invalid_argument),
    }
}

fn required(body: &Value, name: &str) -> R<String> {
    field(body, name)?.ok_or_else(ApiError::invalid_argument)
}

fn version(body: &Value) -> R<u64> {
    body.get("version")
        .and_then(Value::as_u64)
        .ok_or_else(ApiError::invalid_argument)
}

fn submission_no(body: &Value) -> R<u32> {
    body.get("submission_no")
        .and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n).ok())
        .ok_or_else(ApiError::invalid_argument)
}

fn require_id(value: &str) -> R<()> {
    if crate::valid_id(value) {
        Ok(())
    } else {
        Err(ApiError::invalid_argument())
    }
}

fn action_for(path_verb: &str) -> Option<TaskAction> {
    Some(match path_verb {
        "update" => TaskAction::Update,
        "set-reviewer" => TaskAction::SetReviewer,
        "set-requester" => TaskAction::SetRequester,
        "assign" => TaskAction::Assign,
        "accept" => TaskAction::Accept,
        "decline" => TaskAction::Decline,
        "release" => TaskAction::Release,
        "submit" => TaskAction::Submit,
        "request-changes" => TaskAction::RequestChanges,
        "verify" => TaskAction::Verify,
        "cancel" => TaskAction::Cancel,
        _ => return None,
    })
}

fn parse_command(verb: &str, b: &Value) -> R<Command> {
    Ok(match verb {
        "update" => {
            for key in b.as_object().map(|o| o.keys()).into_iter().flatten() {
                if ![
                    "version",
                    "title",
                    "instructions",
                    "acceptance_criteria",
                    "due_at",
                ]
                .contains(&key.as_str())
                {
                    return Err(ApiError::invalid_argument());
                }
            }
            Command::Update {
                version: version(b)?,
                patch: TaskPatch {
                    title: field(b, "title")?,
                    instructions: field(b, "instructions")?,
                    acceptance_criteria: field(b, "acceptance_criteria")?,
                    due_at: int_field(b, "due_at")?,
                },
            }
        }
        "set-reviewer" => Command::SetReviewer {
            version: version(b)?,
            reviewer: required(b, "reviewer")?,
        },
        "set-requester" => Command::SetRequester {
            version: version(b)?,
            requester: required(b, "requester")?,
        },
        "assign" => Command::Assign {
            version: version(b)?,
            assignee: required(b, "assignee")?,
        },
        "accept" => Command::Accept {
            version: version(b)?,
        },
        "decline" => Command::Decline {
            version: version(b)?,
            reason: required(b, "reason")?,
        },
        "release" => Command::Release {
            version: version(b)?,
            reason: required(b, "reason")?,
        },
        "submit" => {
            let artifacts = match b.get("artifacts") {
                None | Some(Value::Null) => vec![],
                Some(Value::Array(items)) => items
                    .iter()
                    .map(|a| {
                        Ok(Artifact {
                            uri: required(a, "uri")?,
                            label: required(a, "label")?,
                        })
                    })
                    .collect::<R<Vec<_>>>()?,
                Some(_) => return Err(ApiError::invalid_argument()),
            };
            Command::Submit {
                version: version(b)?,
                artifacts,
                note: field(b, "note")?,
                commit_sha: field(b, "commit_sha")?,
            }
        }
        "request-changes" => Command::RequestChanges {
            submission_no: submission_no(b)?,
            reason: required(b, "reason")?,
        },
        "verify" => Command::Verify {
            submission_no: submission_no(b)?,
            commit_sha: field(b, "commit_sha")?,
        },
        "cancel" => Command::Cancel {
            version: version(b)?,
            reason: required(b, "reason")?,
        },
        _ => return Err(ApiError::not_found()),
    })
}

/// The command side: runs against current state inside the caller's transaction.
fn handle_task_command(
    sql: &SqlStorage,
    who: &Participant,
    task_id: &str,
    verb: &str,
    body: &Value,
    now: i64,
) -> R<Value> {
    let caller = &who.caller;
    let action = action_for(verb).ok_or_else(ApiError::not_found)?;
    let task = load_task(sql, task_id)?.ok_or_else(ApiError::task_not_found)?;
    let verdict = if action == TaskAction::SetReviewer {
        authorize_reviewer_change(caller, &task)
    } else if action == TaskAction::SetRequester {
        // Authority first, so a malformed body can't tell someone a hidden task exists. `parse_command` refuses it next.
        let requester = body["requester"].as_str().unwrap_or_default();
        let here = participant(sql, &task.requester)?.is_some();
        authorize_requester_change(caller, &task, requester, here)
    } else {
        authorize_task(caller, &task, action)
    };
    ApiError::from_verdict(verdict)?;
    if matches!(action, TaskAction::RequestChanges | TaskAction::Verify)
        && !may_decide_review(caller.kind, store::requires_person_review(sql)?)
    {
        return Err(ApiError::not_allowed());
    }

    let command = parse_command(verb, body)?;
    match &command {
        Command::SetReviewer { reviewer, .. } => require_eligible_reviewer(sql, reviewer)?,
        Command::SetRequester { requester, .. }
        | Command::Assign {
            assignee: requester,
            ..
        } => require_participant(sql, requester)?,
        _ => {}
    }
    let submission = match &command {
        Command::Submit {
            artifacts, note, ..
        } => Some((artifacts.clone(), note.clone())),
        _ => None,
    };
    // Files are checked against the room before `decide`, which counts them, and refuses to approve any without the check's proof.
    let mut observed = Observed::default();
    let files = match &command {
        Command::Submit { artifacts, .. } => {
            submission_files::prepare(sql, caller, &task, body, artifacts.len())?
        }
        _ => vec![],
    };
    observed.submission_files = files.len();
    if let Command::Verify { submission_no, .. } = &command {
        observed.approved_files = submission_files::approval(sql, &task, *submission_no)?;
    }
    let decision =
        decide(&task, &caller.id, command, &observed).map_err(|e| ApiError::from_core(&e))?;
    save_task(sql, &decision.task, now)?;
    if verb == "verify" {
        outputs::record_approval(sql, &decision.task, &caller.id, now)?;
    }
    if let Some((artifacts, note)) = submission {
        exec(sql, "INSERT INTO submission (task_id, submission_no, task_version, note, commit_sha, submitted_by, submitted_org, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", vec![
            task_id.into(), i64::from(decision.task.submission_no).into(), (decision.task.version as i64).into(), opt(&note),
            opt(&decision.task.submission_commit), caller.id.as_str().into(), who.org.as_str().into(), now.into(),
        ])?;
        for artifact in artifacts {
            exec(sql, "INSERT INTO artifact (id, task_id, submission_no, uri, label, submitted_by, submitted_org, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", vec![
                format!("art_{}", uuid::Uuid::new_v4().simple()).into(), task_id.into(), i64::from(decision.task.submission_no).into(),
                artifact.uri.into(), artifact.label.into(), caller.id.as_str().into(), who.org.as_str().into(), now.into(),
            ])?;
        }
        submission_files::record(sql, who, task_id, decision.task.submission_no, files, now)?;
    }
    // Nothing can be uploaded for a task that isn't accepted, so its unfinished uploads end now and give their space back.
    if task.status == TaskStatus::Accepted && decision.task.status != TaskStatus::Accepted {
        objects::drop_uploads_for_task(sql, &caller.id, kind_name(caller), task_id, now)?;
    }
    record_decision(sql, &decision, task.status, &caller.id, now)?;
    Ok(task_json(&decision.task))
}

fn handle_create_task(sql: &SqlStorage, caller: &Caller, body: &Value, now: i64) -> R<Value> {
    ApiError::from_verdict(authorize_workroom(caller, WorkroomAction::CreateTask))?;
    let open = rows(
        sql,
        "SELECT count(*) AS n FROM task WHERE status NOT IN ('completed', 'canceled')",
        vec![],
    )?;
    if open.first().map_or(0, |r| int(&r["n"])) >= MAX_OPEN_TASKS {
        return Err(ApiError::limit_exceeded());
    }
    let new = NewTask {
        id: format!("tsk_{}", uuid::Uuid::new_v4().simple()),
        title: required(body, "title")?,
        instructions: required(body, "instructions")?,
        acceptance_criteria: field(body, "acceptance_criteria")?,
        assignee: field(body, "assignee")?,
        reviewer: field(body, "reviewer")?,
        due_at: int_field(body, "due_at")?,
        follow_up_of: field(body, "follow_up_of")?,
        has_linked_repository: false,
    };
    if let Some(assignee) = &new.assignee {
        require_participant(sql, assignee)?;
    }
    require_eligible_reviewer(sql, new.reviewer.as_deref().unwrap_or(&caller.id))?;
    let decision = decide_create(&caller.id, new).map_err(|e| ApiError::from_core(&e))?;
    store::insert_task(sql, &decision.task, now)?;
    outputs::name_on_create(sql, &decision.task, body)?;
    record_decision(sql, &decision, decision.task.status, &caller.id, now)?;
    let mut created = task_json(&decision.task);
    created["expected_output"] = outputs::of_task(sql, &decision.task.id, false)?;
    Ok(created)
}

fn handle_send_message(
    sql: &SqlStorage,
    who: &Participant,
    task_id: &str,
    body: &Value,
    now: i64,
) -> R<Value> {
    let caller = &who.caller;
    let task = load_task(sql, task_id)?.ok_or_else(ApiError::task_not_found)?;
    ApiError::from_verdict(authorize_task(caller, &task, TaskAction::PostMessage))?;
    // Where the message came from, as the gateway says. Only A2A is named, and it can only refuse more (ADR 0007).
    match field(body, "via")?.as_deref() {
        None => {}
        Some("a2a") if !podster_core::a2a::accepts_inbound_message(task.status) => {
            return Err(ApiError::api(409, "task_closed"))
        }
        Some("a2a") => {}
        Some(_) => return Err(ApiError::invalid_argument()),
    }
    let text_body = required(body, "body")?;
    if text_body.trim().is_empty() || text_body.len() > MAX_MESSAGE_BYTES {
        return Err(ApiError::invalid_argument());
    }
    let id = format!("msg_{}", uuid::Uuid::new_v4().simple());
    exec(sql, "INSERT INTO message (id, task_id, sender_id, sender_org, body, created_at) VALUES (?, ?, ?, ?, ?, ?)", vec![
        id.as_str().into(), task_id.into(), caller.id.as_str().into(), who.org.as_str().into(), text_body.as_str().into(), now.into(),
    ])?;
    let mut parties = vec![task.requester.clone(), task.reviewer.clone()];
    parties.extend(task.assignee.clone());
    parties.sort();
    parties.dedup();
    let mut recipients = Vec::new();
    for party in parties {
        if party != caller.id && participant(sql, &party)?.is_some() {
            store::record_handoff(sql, &caller.id, &party, HandoffKind::Message, task_id, now)?;
            recipients.push(party);
        }
    }
    record_event(
        sql,
        "task.message",
        &caller.id,
        Some(task_id),
        &Transition::NONE,
        recipients,
        now,
    )?;
    Ok(
        json!({ "id": id, "task_id": task_id, "from": { "id": caller.id, "org": who.org }, "body": text_body, "created_at": now }),
    )
}

/// Refuses an access change based on an out-of-date view, so a stale form can't restore revoked access.
fn require_policy_version(sql: &SqlStorage, body: &Value) -> R<()> {
    let expected = body
        .get("policy_version")
        .and_then(Value::as_i64)
        .ok_or_else(ApiError::invalid_argument)?;
    let room = rows(sql, "SELECT policy_version FROM workspace", vec![])?;
    if room.first().map_or(0, |r| int(&r["policy_version"])) != expected {
        return Err(ApiError::from_core(
            &podster_core::CoreError::VersionConflict,
        ));
    }
    Ok(())
}

/// Records an access change and moves the room's policy version, in the caller's transaction.
fn audit(
    sql: &SqlStorage,
    caller: &Caller,
    action: &str,
    target: &str,
    prior: Option<String>,
    new: Option<String>,
    now: i64,
) -> R<()> {
    audit_as(
        sql,
        &caller.id,
        kind_name(caller),
        action,
        target,
        prior,
        new,
        now,
    )
}

#[allow(clippy::too_many_arguments)]
fn audit_as(
    sql: &SqlStorage,
    actor: &str,
    actor_kind: &str,
    action: &str,
    target: &str,
    prior: Option<String>,
    new: Option<String>,
    now: i64,
) -> R<()> {
    exec(
        sql,
        "UPDATE workspace SET policy_version = policy_version + 1",
        vec![],
    )?;
    audit_row(sql, actor, actor_kind, action, target, prior, new, now)
}

/// Records a change to a file, which changes nobody's access, so it leaves the policy version alone. That version guards an
/// admin's open form, and an upload or a scan mustn't make one fail.
#[allow(clippy::too_many_arguments)]
pub(super) fn audit_file(
    sql: &SqlStorage,
    actor: &str,
    actor_kind: &str,
    action: &str,
    target: &str,
    prior: Option<String>,
    new: Option<String>,
    now: i64,
) -> R<()> {
    audit_row(sql, actor, actor_kind, action, target, prior, new, now)
}

/// The audit entry itself, with its place in the audit list. The entry keeps the policy version it was written under.
#[allow(clippy::too_many_arguments)]
fn audit_row(
    sql: &SqlStorage,
    actor: &str,
    actor_kind: &str,
    action: &str,
    target: &str,
    prior: Option<String>,
    new: Option<String>,
    now: i64,
) -> R<()> {
    exec(
        sql,
        "UPDATE workspace SET audit_seq = audit_seq + 1",
        vec![],
    )?;
    exec(sql, "INSERT INTO audit_event (id, actor_id, actor_kind, action, target_id, outcome, prior_json, new_json, policy_version, seq, created_at)
      VALUES (?, ?, ?, ?, ?, 'allowed', ?, ?, (SELECT policy_version FROM workspace), (SELECT audit_seq FROM workspace), ?)", vec![
        format!("aud_{}", uuid::Uuid::new_v4().simple()).into(), actor.into(), actor_kind.into(), action.into(), target.into(), opt(&prior), opt(&new), now.into(),
    ])
}

fn is_owner(sql: &SqlStorage, id: &str) -> R<bool> {
    let room = rows(sql, "SELECT owner_person_id FROM workspace", vec![])?;
    Ok(room.first().and_then(|r| r["owner_person_id"].as_str()) == Some(id))
}

/// Queues a listing update, which the alarm writes to D1 after this transaction commits.
fn queue_index(
    sql: &SqlStorage,
    principal: &str,
    org: &str,
    role: Option<&str>,
    now: i64,
) -> R<()> {
    let _ = now;
    exec(
        sql,
        "INSERT INTO index_outbox (principal_id, org_id, role, removed) VALUES (?, ?, ?, ?)",
        vec![
            principal.into(),
            org.into(),
            role.map_or(worker::SqlStorageValue::Null, Into::into),
            flag(role.is_none()),
        ],
    )
}

/// Refuses a join whose generation is older than a disconnect this room has already acknowledged.
fn require_past_fence(sql: &SqlStorage, principal: &str, generation: u64) -> R<()> {
    let fence = rows(
        sql,
        "SELECT min_generation FROM principal_fence WHERE principal_id = ?",
        vec![principal.into()],
    )?;
    if (generation as i64) < fence.first().map_or(0, |f| int(&f["min_generation"])) {
        return Err(ApiError::agent_disconnected());
    }
    Ok(())
}

fn room_owner_org(sql: &SqlStorage) -> R<String> {
    rows(sql, "SELECT owner_org_id FROM workspace", vec![])?
        .first()
        .and_then(|r| text(&r["owner_org_id"]))
        .ok_or_else(ApiError::workspace_not_found)
}

fn active_count(sql: &SqlStorage) -> R<i64> {
    Ok(rows(
        sql,
        "SELECT count(*) AS n FROM member WHERE revoked_at IS NULL",
        vec![],
    )?
    .first()
    .map_or(0, |r| int(&r["n"])))
}

/// Inserts or restores a member row with its join generation, inside the caller's transaction.
#[allow(clippy::too_many_arguments)]
fn write_member(
    sql: &SqlStorage,
    added_by: &str,
    principal: &str,
    kind: &str,
    org: &str,
    role: &str,
    guest_can_create: bool,
    generation: Option<u64>,
    now: i64,
) -> R<()> {
    exec(sql, "INSERT INTO member (principal_id, kind, org_id, role, guest_can_create, join_generation, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (principal_id) DO UPDATE SET kind = excluded.kind, org_id = excluded.org_id, role = excluded.role, guest_can_create = excluded.guest_can_create,
        join_generation = excluded.join_generation, added_by = excluded.added_by, added_at = excluded.added_at, revoked_at = NULL, revocation_reason = NULL, owner_consented_at = NULL", vec![
        principal.into(), kind.into(), org.into(), role.into(), flag(guest_can_create), generation.map_or(worker::SqlStorageValue::Null, |g| (g as i64).into()), added_by.into(), now.into(),
    ])?;
    // Joining starts from the role's preset, so scopes someone held before they left don't come back with them.
    store::write_grant(
        sql,
        principal,
        Scopes::for_role(parse_role(role), guest_can_create),
        added_by,
        now,
    )?;
    queue_index(sql, principal, org, Some(role), now)
}

/// When the directory says this person joined this organization, or a refusal if it doesn't place them there.
fn joined_org(target: Option<&TargetMember>, person: &str, org: &str) -> R<i64> {
    target
        .filter(|target| target.person == person)
        .and_then(|target| target.orgs.get(org).copied())
        .ok_or_else(ApiError::not_in_organization)
}

/// Adds a participant from the room owner's organization. Other organizations join through an invitation.
/// For an agent, `registered` holds its generation and organization from its Principal. For a person, `target_member`
/// is what the gateway's directory says about them, because someone outside the organization couldn't act on the role.
/// Someone whose role here predates their current membership is added again, because that role has already ended.
fn handle_add_member(
    sql: &SqlStorage,
    caller: &Caller,
    body: &Value,
    registered: Option<(u64, String)>,
    target_member: Option<TargetMember>,
    now: i64,
) -> R<Value> {
    ApiError::from_verdict(authorize_workroom(caller, WorkroomAction::ManageAccess))?;
    require_policy_version(sql, body)?;
    let principal = required(body, "principal_id")?;
    let kind = required(body, "kind")?;
    let org = required(body, "org_id")?;
    let role = required(body, "role")?;
    require_id(&principal)?;
    require_id(&org)?;
    if !["person", "agent"].contains(&kind.as_str())
        || !["admin", "member", "guest"].contains(&role.as_str())
        || is_owner(sql, &principal)?
        || (kind == "person") == principal.starts_with(AGENT_ID_PREFIX)
    {
        return Err(ApiError::invalid_argument());
    }
    // An agent's organization comes from its Principal, never the request.
    let generation = if kind == "agent" {
        let (generation, agent_org) = registered.ok_or_else(ApiError::invalid_argument)?;
        if agent_org != org {
            return Err(ApiError::invalid_argument());
        }
        require_past_fence(sql, &principal, generation)?;
        Some(generation)
    } else {
        None
    };
    if org != room_owner_org(sql)? {
        return Err(ApiError::invitation_required());
    }
    if role == "admin" {
        if kind != "person" {
            return Err(ApiError::invalid_argument());
        }
        ApiError::from_verdict(authorize_workroom(caller, WorkroomAction::AppointAdmin))?;
    }
    let joined = if kind == "person" {
        Some(joined_org(target_member.as_ref(), &principal, &org)?)
    } else {
        None
    };
    let existing = rows(sql, "SELECT kind, org_id, role, revoked_at, revocation_reason, owner_consented_at, added_at FROM member WHERE principal_id = ?", vec![principal.as_str().into()])?;
    let prior = existing.first();
    if let Some(prior) = prior {
        let ended = joined.is_some_and(|since| since > int(&prior["added_at"]));
        if prior["revoked_at"].is_null() && !ended {
            return Err(ApiError::already_member());
        }
        // Correcting a revoked participant's identity is the owner's alone, so an admin can't re-add someone as someone else.
        if prior["kind"].as_str() != Some(kind.as_str())
            || prior["org_id"].as_str() != Some(org.as_str())
        {
            ApiError::from_verdict(authorize_workroom(caller, WorkroomAction::AppointAdmin))?;
        }
        // An agent its own owner took out returns only with that owner's consent.
        let owner_removed = matches!(
            prior["revocation_reason"].as_str(),
            Some("owner_withdrawn" | "global_disconnect")
        );
        if owner_removed && prior["owner_consented_at"].is_null() {
            return Err(ApiError::not_allowed());
        }
    }
    // The owner counts toward the limit.
    if active_count(sql)? + 1 >= MAX_MEMBERS {
        return Err(ApiError::limit_exceeded());
    }
    let guest_can_create = guest_switch(&role, body, false)?;
    let prior_scopes = store::granted_scopes(sql, &principal)?;
    write_member(
        sql,
        &caller.id,
        &principal,
        &kind,
        &org,
        &role,
        guest_can_create,
        generation,
        // The gateway's clock may be ahead, and this must not look older than the membership it belongs to.
        joined.map_or(now, |since| now.max(since)),
    )?;
    let scopes = Scopes::for_role(parse_role(&role), guest_can_create);
    let mut new_json =
        json!({ "role": role, "kind": kind, "org_id": org, "guest_can_create": guest_can_create });
    let prior_json = prior.map(|p| {
        let mut before = json!({ "role": p["role"], "kind": p["kind"], "org_id": p["org_id"], "revoked": !p["revoked_at"].is_null() });
        // Coming back starts from the role's preset, which can widen what they held, so the audit says what moved.
        if prior_scopes != scopes {
            let prior_kind = p["kind"].as_str().map_or(PrincipalKind::Agent, parse_kind);
            let prior_role = p["role"].as_str().map_or(Role::None, parse_role);
            before["access"] = access_json(prior_kind, prior_role, prior_scopes);
            new_json["access"] = access_json(parse_kind(&kind), parse_role(&role), scopes);
        }
        before.to_string()
    });
    audit(
        sql,
        caller,
        "member.added",
        &principal,
        prior_json,
        Some(new_json.to_string()),
        now,
    )?;
    store::record_event_about(
        sql,
        "member.added",
        &caller.id,
        Some(&principal),
        None,
        &Transition::NONE,
        (principal != caller.id).then(|| principal.clone()),
        now,
    )?;
    Ok(json!({ "principal_id": principal, "role": role }))
}

fn invitation_hash(secret: &str) -> String {
    format!("{:x}", Sha256::digest(secret.as_bytes()))
}

/// The room an invitation token belongs to. Tokens look like `inv_<room>.<id>.<secret>`.
pub fn workspace_of_token(token: &str) -> Option<String> {
    let room = token.strip_prefix("inv_")?.split('.').next()?;
    crate::valid_id(room).then(|| room.to_string())
}

fn parse_token(token: &str) -> Option<(String, String)> {
    let mut parts = token.strip_prefix("inv_")?.split('.');
    let (_room, id, secret) = (parts.next()?, parts.next()?, parts.next()?);
    parts
        .next()
        .is_none()
        .then(|| (id.to_string(), secret.to_string()))
}

fn handle_create_invitation(
    sql: &SqlStorage,
    caller: &Caller,
    room: &str,
    body: &Value,
    now: i64,
) -> R<Value> {
    ApiError::from_verdict(authorize_workroom(caller, WorkroomAction::ManageAccess))?;
    require_policy_version(sql, body)?;
    let role = field(body, "role")?.unwrap_or_else(|| "guest".to_string());
    if !["member", "guest"].contains(&role.as_str()) {
        return Err(ApiError::invalid_argument());
    }
    let invited_org = field(body, "invited_org_id")?;
    if let Some(org) = &invited_org {
        require_id(org)?;
    }
    let guest_can_create = guest_switch(&role, body, false)?;
    // A link may name an opening. It must be one that's open now, and joining through it only invites the agent.
    let work_role = field(body, "work_role_id")?;
    if let Some(work_role) = &work_role {
        require_id(work_role)?;
        if rows(
            sql,
            "SELECT id FROM work_role WHERE id = ? AND closed_at IS NULL",
            vec![work_role.as_str().into()],
        )?
        .is_empty()
        {
            return Err(ApiError::invalid_argument());
        }
    }
    let id = format!("ivt_{}", uuid::Uuid::new_v4().simple());
    let secret = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let expires_at = now + INVITATION_TTL_MS;
    exec(sql, "INSERT INTO invitation (id, work_role_id, invited_org_id, role, guest_can_create, token_hash, expires_at, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)", vec![
        id.as_str().into(), opt(&work_role), opt(&invited_org), role.as_str().into(), flag(guest_can_create), invitation_hash(&secret).into(), expires_at.into(), caller.id.as_str().into(), now.into(),
    ])?;
    audit(
        sql,
        caller,
        "invitation.created",
        &id,
        None,
        Some(
            json!({ "role": role, "invited_org_id": invited_org, "work_role_id": work_role })
                .to_string(),
        ),
        now,
    )?;
    // The token is returned once. Only its hash is stored, and `command` removes it from the idempotency record.
    Ok(
        json!({ "id": id, "token": format!("inv_{room}.{id}.{secret}"), "role": role, "work_role_id": work_role, "expires_at": expires_at }),
    )
}

fn handle_withdraw_invitation(
    sql: &SqlStorage,
    caller: &Caller,
    id: &str,
    body: &Value,
    now: i64,
) -> R<Value> {
    ApiError::from_verdict(authorize_workroom(caller, WorkroomAction::ManageAccess))?;
    require_policy_version(sql, body)?;
    let found = rows(
        sql,
        "SELECT status FROM invitation WHERE id = ?",
        vec![id.into()],
    )?;
    if found.first().and_then(|r| r["status"].as_str()) != Some("pending") {
        return Err(ApiError::invitation_not_found());
    }
    exec(
        sql,
        "UPDATE invitation SET status = 'withdrawn' WHERE id = ?",
        vec![id.into()],
    )?;
    audit(sql, caller, "invitation.withdrawn", id, None, None, now)?;
    Ok(json!({ "id": id, "status": "withdrawn" }))
}

/// A valid pending invitation for this token, or nothing. Every failure looks the same.
fn find_invitation(sql: &SqlStorage, id: &str, secret: &str, now: i64) -> R<Option<Value>> {
    let found = rows(
        sql,
        "SELECT * FROM invitation WHERE id = ?",
        vec![id.into()],
    )?;
    let Some(row) = found.into_iter().next().filter(|row| {
        row["token_hash"].as_str() == Some(invitation_hash(secret).as_str())
            && (row["status"].as_str() == Some("accepted")
                || int(&row["expires_at"]) > now && row["status"].as_str() == Some("pending"))
    }) else {
        return Ok(None);
    };
    // A pending invitation lasts only as long as its creator can still invite here. An accepted one is only replayed.
    if row["status"].as_str() == Some("pending") {
        if room_archived(sql)? {
            return Ok(None);
        }
        let creator = row["created_by"].as_str().unwrap_or_default();
        let can_invite =
            participant(sql, creator)?.is_some_and(|(_, role)| role == "owner" || role == "admin");
        if !can_invite {
            return Ok(None);
        }
    }
    Ok(Some(row))
}

/// Changes an active member's role. Any change to or from admin is the owner's alone.
fn handle_change_role(
    sql: &SqlStorage,
    caller: &Caller,
    principal: &str,
    body: &Value,
    target_member: Option<TargetMember>,
    now: i64,
) -> R<Value> {
    ApiError::from_verdict(authorize_workroom(caller, WorkroomAction::ManageAccess))?;
    require_policy_version(sql, body)?;
    let role = required(body, "role")?;
    if !["admin", "member", "guest"].contains(&role.as_str()) {
        return Err(ApiError::invalid_argument());
    }
    let found = rows(sql, "SELECT kind, role, guest_can_create, org_id, added_at FROM member WHERE principal_id = ? AND revoked_at IS NULL", vec![principal.into()])?;
    let member = found.first().ok_or_else(ApiError::invalid_argument)?;
    if role == "admin" && member["kind"].as_str() != Some("person") {
        return Err(ApiError::invalid_argument());
    }
    if role == "admin" || member["role"].as_str() == Some("admin") {
        ApiError::from_verdict(authorize_workroom(caller, WorkroomAction::AppointAdmin))?;
    }
    // A role can't be changed for someone who can't act on it. They've left, or this role predates their membership.
    if member["kind"].as_str() == Some("person") {
        let org = text(&member["org_id"]).unwrap_or_default();
        if joined_org(target_member.as_ref(), principal, &org)? > int(&member["added_at"]) {
            return Err(ApiError::not_in_organization());
        }
    }
    let stored_switch = int(&member["guest_can_create"]) != 0;
    let guest_can_create = guest_switch(&role, body, stored_switch)?;
    if role != "admin" && member["role"].as_str() == Some("admin") {
        end_invitations_of(
            sql,
            &caller.id,
            kind_name(caller),
            principal,
            "role_changed",
            now,
        )?;
    }
    // A changed role starts again from its preset, which can widen as well as narrow, so the audit says what moved.
    // Saving the same role keeps any scopes adjusted since.
    let prior_scopes = store::granted_scopes(sql, principal)?;
    let mut scopes = prior_scopes;
    if member["role"].as_str() != Some(role.as_str())
        || (role == "guest" && stored_switch != guest_can_create)
    {
        scopes = Scopes::for_role(parse_role(&role), guest_can_create);
        store::write_grant(sql, principal, scopes, &caller.id, now)?;
        roles::withdraw_role_invites(sql, principal)?;
    } else if !rows(
        sql,
        "SELECT id FROM role_claim WHERE principal_id = ? AND status = 'active'",
        vec![principal.into()],
    )?
    .is_empty()
    {
        // On someone holding an opening, saving the same thing is the room choosing to keep them there, as on the access
        // route, and releasing the opening mustn't undo that.
        store::write_grant(sql, principal, scopes, &caller.id, now)?;
        roles::withdraw_role_invites(sql, principal)?;
    }
    let target_kind = member["kind"]
        .as_str()
        .map_or(PrincipalKind::Agent, parse_kind);
    let moved = (scopes != prior_scopes).then(|| {
        (
            access_json(
                target_kind,
                member["role"].as_str().map_or(Role::None, parse_role),
                prior_scopes,
            ),
            access_json(target_kind, parse_role(&role), scopes),
        )
    });
    exec(
        sql,
        "UPDATE member SET role = ?, guest_can_create = ? WHERE principal_id = ?",
        vec![
            role.as_str().into(),
            flag(guest_can_create),
            principal.into(),
        ],
    )?;
    objects::drop_uploads_no_longer_allowed(sql, &caller.id, "person", principal, now)?;
    let org = rows(
        sql,
        "SELECT org_id FROM member WHERE principal_id = ?",
        vec![principal.into()],
    )?
    .first()
    .and_then(|m| text(&m["org_id"]))
    .unwrap_or_default();
    queue_index(sql, principal, &org, Some(&role), now)?;
    let mut prior = json!({ "role": member["role"], "guest_can_create": int(&member["guest_can_create"]) != 0 });
    let mut new = json!({ "role": role, "guest_can_create": guest_can_create });
    if let Some((before, after)) = moved {
        prior["access"] = before;
        new["access"] = after;
    }
    audit(
        sql,
        caller,
        "member.role_changed",
        principal,
        Some(prior.to_string()),
        Some(new.to_string()),
        now,
    )?;
    record_event(
        sql,
        "member.role_changed",
        &caller.id,
        None,
        &Transition::NONE,
        (principal != caller.id).then(|| principal.to_string()),
        now,
    )?;
    Ok(json!({ "principal_id": principal, "role": role }))
}

/// The caller's or a participant's access as the API shows it. A human owner or admin holds everything by their role, so
/// they have no preset.
fn access_json(kind: PrincipalKind, role: Role, stored: Scopes) -> Value {
    let scopes = effective_scopes(kind, role, stored);
    let by_role = matches!(role, Role::Owner | Role::Admin);
    json!({
        "preset": if by_role { None } else { scopes.preset().map(Preset::name) },
        "tasks": scopes.tasks.name(), "artifacts": scopes.artifacts.name(),
        "conversations": scopes.conversations.name(), "review": scopes.review.name(),
    })
}

/// A guest's task-creating switch from a request. It means nothing for any other role, so it's always false for them,
/// whatever was sent.
fn guest_switch(role: &str, body: &Value, otherwise: bool) -> R<bool> {
    let given = match body.get("guest_can_create") {
        None => otherwise,
        Some(value) => value.as_bool().ok_or_else(ApiError::invalid_argument)?,
    };
    Ok(role == "guest" && given)
}

/// Applies a named scope from a request. Only these four exist, so anything else, such as managing access, is refused.
fn adjust_scope(scopes: &mut Scopes, name: &str, value: &Value) -> R<()> {
    let value = value.as_str().ok_or_else(ApiError::invalid_argument)?;
    let bad = ApiError::invalid_argument;
    match name {
        "tasks" => scopes.tasks = TaskScope::from_name(value).ok_or_else(bad)?,
        "artifacts" => scopes.artifacts = ArtifactScope::from_name(value).ok_or_else(bad)?,
        "conversations" => {
            scopes.conversations = ConversationScope::from_name(value).ok_or_else(bad)?;
        }
        "review" => scopes.review = ReviewScope::from_name(value).ok_or_else(bad)?,
        _ => return Err(bad()),
    }
    Ok(())
}

/// Someone who can't review any more can't stay named on open tasks, or they'd wait forever.
fn review_after_change(
    sql: &SqlStorage,
    actor: &Caller,
    principal: &str,
    prior: Scopes,
    next: Scopes,
    now: i64,
) -> R<()> {
    if !prior.reviews() || next.reviews() {
        return Ok(());
    }
    let named = rows(
        sql,
        "SELECT * FROM task WHERE status NOT IN ('completed', 'canceled') AND reviewer_id = ?",
        vec![principal.into()],
    )?;
    for row in &named {
        let task = store::task_from_row(row)?;
        let requester_ok = eligible_reviewer(sql, &task.requester)?;
        if let Some(decision) = apply_review_ended(&task, principal, requester_ok) {
            save_task(sql, &decision.task, now)?;
            record_decision(sql, &decision, task.status, &actor.id, now)?;
        }
    }
    Ok(())
}

/// Applies a preset to an agent, adjusts its scopes, or both. Only the server's values are stored, and a preset's role is
/// never an administrator's. People's access follows their role here, because decision 20 is about agents.
fn handle_change_access(
    sql: &SqlStorage,
    caller: &Caller,
    principal: &str,
    body: &Value,
    now: i64,
) -> R<Value> {
    ApiError::from_verdict(authorize_workroom(caller, WorkroomAction::ManageAccess))?;
    require_policy_version(sql, body)?;
    let found = rows(sql, "SELECT kind, org_id, role, guest_can_create FROM member WHERE principal_id = ? AND revoked_at IS NULL", vec![principal.into()])?;
    let member = found.first().ok_or_else(ApiError::invalid_argument)?;
    if member["kind"].as_str() != Some("agent") {
        return Err(ApiError::invalid_argument());
    }
    let preset = match body.get("preset") {
        None => None,
        Some(name) => Some(
            name.as_str()
                .and_then(Preset::from_name)
                .ok_or_else(ApiError::invalid_argument)?,
        ),
    };
    let adjustments = match body.get("scopes") {
        None => None,
        Some(given) => Some(given.as_object().ok_or_else(ApiError::invalid_argument)?),
    };
    if preset.is_none() && adjustments.is_none() {
        return Err(ApiError::invalid_argument());
    }
    let prior = store::granted_scopes(sql, principal)?;
    let mut next = preset.map_or(prior, Preset::scopes);
    for (name, value) in adjustments.into_iter().flatten() {
        adjust_scope(&mut next, name, value)?;
    }
    if !next.is_grantable() {
        return Err(ApiError::invalid_argument());
    }
    let prior_role = text(&member["role"]).unwrap_or_default();
    let role = preset.map_or(prior_role.clone(), |p| p.role_name().to_string());
    let answer = |scopes| json!({ "principal_id": principal, "role": role, "access": access_json(PrincipalKind::Agent, parse_role(&role), scopes) });
    // On someone holding an opening, an explicit call counts even with the same values: it's the room choosing to keep
    // them there, and releasing the opening mustn't undo that.
    let holds_opening = !rows(
        sql,
        "SELECT id FROM role_claim WHERE principal_id = ? AND status = 'active'",
        vec![principal.into()],
    )?
    .is_empty();
    if next == prior && role == prior_role && !holds_opening {
        return Ok(answer(prior));
    }
    let org = text(&member["org_id"]).unwrap_or_default();
    store::write_grant(sql, principal, next, &caller.id, now)?;
    exec(
        sql,
        "UPDATE member SET role = ?, guest_can_create = ? WHERE principal_id = ?",
        vec![
            role.as_str().into(),
            flag(role == "guest" && next.tasks.can_create()),
            principal.into(),
        ],
    )?;
    objects::drop_uploads_no_longer_allowed(sql, &caller.id, "person", principal, now)?;
    if role != prior_role {
        queue_index(sql, principal, &org, Some(&role), now)?;
    }
    audit(
        sql,
        caller,
        "member.access_changed",
        principal,
        Some(json!({ "role": prior_role, "access": access_json(PrincipalKind::Agent, parse_role(&prior_role), prior) }).to_string()),
        Some(json!({ "role": role, "access": access_json(PrincipalKind::Agent, parse_role(&role), next) }).to_string()),
        now,
    )?;
    record_event(
        sql,
        "member.access_changed",
        &caller.id,
        None,
        &Transition::NONE,
        [principal.to_string()],
        now,
    )?;
    review_after_change(sql, caller, principal, prior, next, now)?;
    roles::withdraw_role_invites(sql, principal)?;
    Ok(answer(next))
}

/// A brief field in a request: absent leaves it alone, null clears it, and anything but text is refused.
fn brief_change(body: &Value, name: &str) -> R<Option<Option<String>>> {
    match body.get(name) {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(Value::String(given)) => Ok(Some(Some(given.clone()))),
        Some(_) => Err(ApiError::invalid_argument()),
    }
}

/// Changes a room's goal or context. They're text for participants to read, and nothing in Podster acts on them, so the
/// audit entry and the event say only what changed, never what it says.
fn handle_set_brief(sql: &SqlStorage, caller: &Caller, body: &Value, now: i64) -> R<Value> {
    ApiError::from_verdict(authorize_workroom(caller, WorkroomAction::ManageRoom))?;
    require_policy_version(sql, body)?;
    let goal = brief_change(body, "goal")?;
    let context = brief_change(body, "context")?;
    if goal.is_none() && context.is_none() {
        return Err(ApiError::invalid_argument());
    }
    validate_brief(
        goal.as_ref().and_then(|g| g.as_deref()),
        context.as_ref().and_then(|c| c.as_deref()),
    )
    .map_err(|e| ApiError::from_core(&e))?;
    exec(
        sql,
        "UPDATE workspace SET brief_by = ?",
        vec![caller.id.as_str().into()],
    )?;
    if let Some(goal) = &goal {
        exec(sql, "UPDATE workspace SET goal = ?", vec![opt(goal)])?;
    }
    if let Some(context) = &context {
        exec(sql, "UPDATE workspace SET context = ?", vec![opt(context)])?;
    }
    audit(
        sql,
        caller,
        "workspace.brief_changed",
        "workspace",
        None,
        Some(json!({ "goal": goal.is_some(), "context": context.is_some() }).to_string()),
        now,
    )?;
    let mut everyone = room_people(sql)?;
    everyone.retain(|principal| *principal != caller.id);
    record_event(
        sql,
        "workspace.brief_changed",
        &caller.id,
        None,
        &Transition::NONE,
        everyone,
        now,
    )?;
    let room = rows(sql, "SELECT goal, context FROM workspace", vec![])?;
    let room = room.first().ok_or_else(ApiError::workspace_not_found)?;
    Ok(json!({ "goal": room["goal"], "context": room["context"] }))
}

/// Sets whether this room requires a person to review (decision 5). Turning it on moves open tasks off agent reviewers by
/// the reviewer half of the departure rules, so an agent named earlier can't be left named where it can't decide. Turning
/// it off moves nothing.
fn handle_set_review_policy(sql: &SqlStorage, caller: &Caller, body: &Value, now: i64) -> R<Value> {
    ApiError::from_verdict(authorize_workroom(caller, WorkroomAction::ManageRoom))?;
    require_policy_version(sql, body)?;
    let require_person = body
        .get("require_person")
        .and_then(Value::as_bool)
        .ok_or_else(ApiError::invalid_argument)?;
    let prior = store::requires_person_review(sql)?;
    if prior != require_person {
        exec(
            sql,
            "UPDATE workspace SET require_person_review = ?",
            vec![flag(require_person)],
        )?;
        audit(
            sql,
            caller,
            "workspace.review_policy_changed",
            "workspace",
            Some(json!({ "require_person": prior }).to_string()),
            Some(json!({ "require_person": require_person }).to_string()),
            now,
        )?;
        let mut everyone = room_people(sql)?;
        everyone.retain(|principal| *principal != caller.id);
        record_event(
            sql,
            "workspace.review_policy_changed",
            &caller.id,
            None,
            &Transition::NONE,
            everyone,
            now,
        )?;
        if require_person {
            let open = rows(
                sql,
                "SELECT * FROM task WHERE status NOT IN ('completed', 'canceled')",
                vec![],
            )?;
            for row in &open {
                let task = store::task_from_row(row)?;
                // Already flagged means someone has been told, so turning it on again changes nothing for them.
                if parse_kind_of(&task.reviewer) == PrincipalKind::Agent && !task.needs_reviewer {
                    let requester_ok = eligible_reviewer(sql, &task.requester)?;
                    if let Some(decision) = apply_review_ended(&task, &task.reviewer, requester_ok)
                    {
                        save_task(sql, &decision.task, now)?;
                        record_decision(sql, &decision, task.status, &caller.id, now)?;
                    }
                }
            }
        }
    }
    Ok(json!({ "require_person": require_person }))
}

/// Tests hold delivery by creating this table, so they can look at what a command queued.
fn outbox_held(sql: &SqlStorage) -> R<bool> {
    #[cfg(feature = "failpoints")]
    if !rows(
        sql,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_hold_outbox'",
        vec![],
    )?
    .is_empty()
    {
        return Ok(true);
    }
    let _ = sql;
    Ok(false)
}

async fn send_to_inbox(env: &Env, recipient: &str, body: &Value) -> bool {
    let attempt = async {
        let stub = env
            .durable_object("PRINCIPAL")?
            .id_from_name(recipient)?
            .get_stub()?;
        let mut init = RequestInit::new();
        init.with_method(Method::Post)
            .with_body(Some(body.to_string().into()));
        let request = Request::new_with_init("https://principal/internal/deliver", &init)?;
        stub.fetch_with_request(request).await
    };
    let timeout = Delay::from(std::time::Duration::from_millis(DELIVERY_TIMEOUT_MS));
    match futures_util::future::select(Box::pin(attempt), timeout).await {
        futures_util::future::Either::Left((result, _)) => {
            let result: Result<Response> = result;
            matches!(result.map(|r| r.status_code()), Ok(200))
        }
        // Dropping this doesn't cancel the send, which can still arrive later. Delivery is idempotent, and the room's
        // removal floor refuses it if the recipient was removed in the meantime.
        futures_util::future::Either::Right(_) => false,
    }
}

/// Ends the pending invitations this person made, because they can no longer invite. Being made an admin again later
/// doesn't bring them back.
fn end_invitations_of(
    sql: &SqlStorage,
    actor: &str,
    actor_kind: &str,
    creator: &str,
    reason: &str,
    now: i64,
) -> R<()> {
    // What they offered as a role's invites ends with their authority too, so being appointed again can't revive it.
    exec(
        sql,
        "DELETE FROM role_invite WHERE invited_by = ?",
        vec![creator.into()],
    )?;
    let pending = rows(
        sql,
        "SELECT id FROM invitation WHERE created_by = ? AND status = 'pending'",
        vec![creator.into()],
    )?;
    for invitation in &pending {
        let id = text(&invitation["id"]).unwrap_or_default();
        exec(
            sql,
            "UPDATE invitation SET status = 'withdrawn' WHERE id = ?",
            vec![id.as_str().into()],
        )?;
        let reason = json!({ "reason": reason }).to_string();
        audit_as(
            sql,
            actor,
            actor_kind,
            "invitation.withdrawn",
            &id,
            None,
            Some(reason),
            now,
        )?;
    }
    Ok(())
}

/// Applies the departure table to a principal's open tasks, and drops anything still queued for them.
fn apply_departure_rules(sql: &SqlStorage, actor: &Caller, principal: &str, now: i64) -> R<()> {
    let affected = rows(sql, "SELECT * FROM task WHERE status NOT IN ('completed', 'canceled') AND (assignee_id = ? OR reviewer_id = ? OR requester_id = ?)",
        vec![principal.into(), principal.into(), principal.into()])?;
    for row in &affected {
        let task = store::task_from_row(row)?;
        let requester_ok = eligible_reviewer(sql, &task.requester)?;
        if let Some(decision) = apply_departure(&task, principal, requester_ok) {
            save_task(sql, &decision.task, now)?;
            record_decision(sql, &decision, task.status, &actor.id, now)?;
        }
    }
    exec(
        sql,
        "DELETE FROM outbox WHERE recipient_principal_id = ?",
        vec![principal.into()],
    )?;
    Ok(())
}

/// Removes a participant and applies the departure rules, inside the caller's transaction.
/// Used by room revocation, agent-owner withdrawal and global disconnect, which differ only by actor and reason.
fn remove_member(
    sql: &SqlStorage,
    actor: &Caller,
    actor_kind: &str,
    principal: &str,
    reason: &str,
    now: i64,
) -> R<()> {
    let prior = rows(
        sql,
        "SELECT role, org_id FROM member WHERE principal_id = ?",
        vec![principal.into()],
    )?;
    let prior_role = prior
        .first()
        .map(|m| m["role"].clone())
        .unwrap_or(Value::Null);
    let org = prior
        .first()
        .and_then(|m| text(&m["org_id"]))
        .unwrap_or_default();
    // Leaving ends claims and frees those openings (decision 42), and an invite can't outlive the place it was made for.
    roles::end_claim(
        sql, actor, actor_kind, principal, "revoked", reason, true, now,
    )?;
    roles::withdraw_role_invites(sql, principal)?;
    exec(sql, "UPDATE member SET revoked_at = ?, revocation_reason = ?, owner_consented_at = NULL WHERE principal_id = ?", vec![now.into(), reason.into(), principal.into()])?;
    apply_departure_rules(sql, actor, principal, now)?;
    objects::drop_uploads_of(sql, &actor.id, actor_kind, principal, now)?;
    end_invitations_of(sql, &actor.id, actor_kind, principal, reason, now)?;
    audit_as(
        sql,
        &actor.id,
        actor_kind,
        "member.revoked",
        principal,
        Some(json!({ "role": prior_role, "reason": reason }).to_string()),
        None,
        now,
    )?;
    queue_index(sql, principal, &org, None, now)?;
    // The removal notice is the one event a revoked principal still receives.
    record_event(
        sql,
        "member.revoked",
        &actor.id,
        None,
        &Transition::NONE,
        [principal.to_string()],
        now,
    )
}

/// Revokes a participant. Later requests fail, and the departure rules apply to their tasks.
/// An agent that's already out can still be removed, so the room's decision holds if it tries to return.
fn handle_revoke_member(
    sql: &SqlStorage,
    caller: &Caller,
    principal: &str,
    body: &Value,
    now: i64,
) -> R<Value> {
    ApiError::from_verdict(authorize_workroom(caller, WorkroomAction::ManageAccess))?;
    require_policy_version(sql, body)?;
    let found = rows(
        sql,
        "SELECT kind, role, revoked_at, revocation_reason FROM member WHERE principal_id = ?",
        vec![principal.into()],
    )?;
    let Some(member) = found.first() else {
        return Err(ApiError::invalid_argument());
    };
    if member["role"].as_str() == Some("admin") {
        ApiError::from_verdict(authorize_workroom(caller, WorkroomAction::AppointAdmin))?;
    }
    if !member["revoked_at"].is_null() {
        if member["kind"].as_str() != Some("agent")
            || member["revocation_reason"].as_str() == Some("room_removed")
        {
            return Err(ApiError::invalid_argument());
        }
        exec(
            sql,
            "UPDATE member SET revocation_reason = 'room_removed' WHERE principal_id = ?",
            vec![principal.into()],
        )?;
        audit(
            sql,
            caller,
            "member.removal_recorded",
            principal,
            Some(json!({ "reason": member["revocation_reason"] }).to_string()),
            None,
            now,
        )?;
        return Ok(json!({ "principal_id": principal, "status": "revoked" }));
    }
    remove_member(
        sql,
        caller,
        kind_name(caller),
        principal,
        "room_removed",
        now,
    )?;
    Ok(json!({ "principal_id": principal, "status": "revoked" }))
}

/// Revokes another organization from the room: its participants leave under the departure rules, an agent already out
/// can't return on its owner's consent alone, and invitations from before now can't bring the organization back. A
/// new invitation is the room's decision to let it return.
fn handle_revoke_organization(
    sql: &SqlStorage,
    caller: &Caller,
    org: &str,
    body: &Value,
    now: i64,
) -> R<Value> {
    ApiError::from_verdict(authorize_workroom(caller, WorkroomAction::ManageAccess))?;
    require_policy_version(sql, body)?;
    require_id(org)?;
    // The room's own organization holds its owner and admins. Its people leave through that organization instead.
    if org == room_owner_org(sql)? {
        return Err(ApiError::invalid_argument());
    }
    let members = rows(
        sql,
        "SELECT principal_id, kind, role, revoked_at, revocation_reason FROM member WHERE org_id = ? ORDER BY principal_id",
        vec![org.into()],
    )?;
    // Only the owner removes an admin, as with one member. An older room could hold another organization's person.
    if members
        .iter()
        .any(|m| m["revoked_at"].is_null() && m["role"].as_str() == Some("admin"))
    {
        ApiError::from_verdict(authorize_workroom(caller, WorkroomAction::AppointAdmin))?;
    }
    let actor_kind = kind_name(caller);
    let mut revoked = Vec::new();
    for member in &members {
        let principal = text(&member["principal_id"]).unwrap_or_default();
        if member["revoked_at"].is_null() {
            remove_member(sql, caller, actor_kind, &principal, "room_removed", now)?;
            revoked.push(principal);
        } else if member["kind"].as_str() == Some("agent")
            && member["revocation_reason"].as_str() != Some("room_removed")
        {
            exec(
                sql,
                "UPDATE member SET revocation_reason = 'room_removed' WHERE principal_id = ?",
                vec![principal.as_str().into()],
            )?;
            audit(
                sql,
                caller,
                "member.removal_recorded",
                &principal,
                Some(json!({ "reason": member["revocation_reason"] }).to_string()),
                None,
                now,
            )?;
        }
    }
    let named = rows(
        sql,
        "SELECT id FROM invitation WHERE invited_org_id = ? AND status = 'pending'",
        vec![org.into()],
    )?;
    for invitation in &named {
        let id = text(&invitation["id"]).unwrap_or_default();
        exec(
            sql,
            "UPDATE invitation SET status = 'withdrawn' WHERE id = ?",
            vec![id.as_str().into()],
        )?;
        let reason = json!({ "reason": "organization_revoked" }).to_string();
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
    exec(
        sql,
        "INSERT INTO org_revocation (org_id, revoked_at) VALUES (?, ?)
          ON CONFLICT (org_id) DO UPDATE SET revoked_at = excluded.revoked_at",
        vec![org.into(), now.into()],
    )?;
    audit(
        sql,
        caller,
        "organization.revoked",
        org,
        None,
        Some(json!({ "revoked": revoked }).to_string()),
        now,
    )?;
    Ok(json!({ "org_id": org, "revoked": revoked }))
}

/// Whether this organization was revoked from the room at or after the invitation was made.
fn barred_by_revocation(sql: &SqlStorage, org: &str, invitation: &Value) -> R<bool> {
    let found = rows(
        sql,
        "SELECT revoked_at FROM org_revocation WHERE org_id = ?",
        vec![org.into()],
    )?;
    Ok(found
        .first()
        .is_some_and(|row| int(&invitation["created_at"]) <= int(&row["revoked_at"])))
}

fn room_archived(sql: &SqlStorage) -> R<bool> {
    Ok(rows(sql, "SELECT status FROM workspace", vec![])?
        .first()
        .and_then(|room| room["status"].as_str().map(|status| status == ARCHIVED))
        .unwrap_or(false))
}

/// Queues a listing update for everyone still in the room, because its name and status are on each of their rows. Rows
/// for anyone who left keep what they had, so a later name or status doesn't reach them.
fn requeue_listing(sql: &SqlStorage, now: i64) -> R<()> {
    let room = rows(
        sql,
        "SELECT owner_person_id, owner_org_id FROM workspace",
        vec![],
    )?;
    if let Some(room) = room.first() {
        queue_index(
            sql,
            room["owner_person_id"].as_str().unwrap_or_default(),
            room["owner_org_id"].as_str().unwrap_or_default(),
            Some("owner"),
            now,
        )?;
    }
    for member in rows(
        sql,
        "SELECT principal_id, org_id, role FROM member WHERE revoked_at IS NULL",
        vec![],
    )? {
        queue_index(
            sql,
            member["principal_id"].as_str().unwrap_or_default(),
            member["org_id"].as_str().unwrap_or_default(),
            member["role"].as_str(),
            now,
        )?;
    }
    Ok(())
}

fn handle_rename_room(sql: &SqlStorage, caller: &Caller, body: &Value, now: i64) -> R<Value> {
    ApiError::from_verdict(authorize_workroom(caller, WorkroomAction::ManageRoom))?;
    require_policy_version(sql, body)?;
    let name = required(body, "name")?;
    if name.trim().is_empty() || name.len() > MAX_NAME_BYTES {
        return Err(ApiError::invalid_argument());
    }
    let prior = rows(sql, "SELECT name FROM workspace", vec![])?;
    let prior = prior.first().map(|room| room["name"].clone());
    exec(
        sql,
        "UPDATE workspace SET name = ?",
        vec![name.as_str().into()],
    )?;
    requeue_listing(sql, now)?;
    audit(
        sql,
        caller,
        "workspace.renamed",
        "workspace",
        prior.map(|name| json!({ "name": name }).to_string()),
        Some(json!({ "name": name }).to_string()),
        now,
    )?;
    Ok(json!({ "name": name }))
}

/// Archives a room or brings it back. Everyone in the room hears, so agents can stop working in it.
fn handle_set_room_status(
    sql: &SqlStorage,
    caller: &Caller,
    status: &str,
    body: &Value,
    now: i64,
) -> R<Value> {
    ApiError::from_verdict(authorize_workroom(caller, WorkroomAction::ManageRoom))?;
    require_policy_version(sql, body)?;
    if room_archived(sql)? == (status == ARCHIVED) {
        return Err(ApiError::from_core(
            &podster_core::CoreError::InvalidTransition,
        ));
    }
    exec(sql, "UPDATE workspace SET status = ?", vec![status.into()])?;
    requeue_listing(sql, now)?;
    let kind = if status == ARCHIVED {
        "workspace.archived"
    } else {
        "workspace.unarchived"
    };
    audit(sql, caller, kind, "workspace", None, None, now)?;
    let mut everyone = room_people(sql)?;
    everyone.retain(|principal| *principal != caller.id);
    record_event(
        sql,
        kind,
        &caller.id,
        None,
        &Transition::NONE,
        everyone,
        now,
    )?;
    Ok(json!({ "status": status }))
}

/// Everyone currently in the room, including an owner who hasn't left.
fn room_people(sql: &SqlStorage) -> R<Vec<String>> {
    let mut everyone: Vec<String> = rows(
        sql,
        "SELECT principal_id FROM member WHERE revoked_at IS NULL",
        vec![],
    )?
    .iter()
    .filter_map(|member| text(&member["principal_id"]))
    .collect();
    everyone.extend(
        rows(
            sql,
            "SELECT owner_person_id FROM workspace WHERE owner_left_at IS NULL",
            vec![],
        )?
        .iter()
        .filter_map(|room| text(&room["owner_person_id"])),
    );
    Ok(everyone)
}

/// Makes someone the room's owner. An owner isn't a member row, so theirs goes, revoked or not. `since` is the start of
/// their current membership, so rejoining later doesn't keep this authority, and an older departure doesn't end it.
fn set_owner(sql: &SqlStorage, person: &str, since: i64) -> R<()> {
    exec(
        sql,
        "DELETE FROM member WHERE principal_id = ?",
        vec![person.into()],
    )?;
    exec(
        sql,
        "UPDATE workspace SET owner_person_id = ?, owner_since = ?, owner_left_at = NULL",
        vec![person.into(), since.into()],
    )
}

/// The owner hands the room to one of its human admins, who becomes owner at once, and they become an admin.
/// `target_member` is what the gateway's directory says about the new owner.
fn handle_transfer_owner(
    sql: &SqlStorage,
    caller: &Caller,
    body: &Value,
    target_member: Option<TargetMember>,
    now: i64,
) -> R<Value> {
    ApiError::from_verdict(authorize_workroom(caller, WorkroomAction::TransferOwner))?;
    require_policy_version(sql, body)?;
    let to = required(body, "to")?;
    let found = rows(
        sql,
        "SELECT kind, role, added_at FROM member WHERE principal_id = ? AND revoked_at IS NULL",
        vec![to.as_str().into()],
    )?;
    let member = found.first().ok_or_else(ApiError::invalid_argument)?;
    if member["kind"].as_str() != Some("person") || member["role"].as_str() != Some("admin") {
        return Err(ApiError::invalid_argument());
    }
    let org = room_owner_org(sql)?;
    // Someone who has left, or whose role predates their membership, can't act on it, so they can't own the room either.
    let joined = joined_org(target_member.as_ref(), &to, &org)?;
    if joined > int(&member["added_at"]) {
        return Err(ApiError::not_in_organization());
    }
    let room = rows(sql, "SELECT owner_since FROM workspace", vec![])?;
    // The former owner's role starts with their membership, so a departure from before now that hasn't arrived still ends it.
    let former_since = room
        .first()
        .and_then(|room| room["owner_since"].as_i64())
        .unwrap_or(now);
    set_owner(sql, &to, joined)?;
    exec(
        sql,
        "INSERT INTO member (principal_id, kind, org_id, role, added_by, added_at) VALUES (?, 'person', ?, 'admin', ?, ?)",
        vec![
            caller.id.as_str().into(),
            org.as_str().into(),
            caller.id.as_str().into(),
            former_since.into(),
        ],
    )?;
    store::write_grant(sql, &caller.id, Scopes::MEMBER, &caller.id, now)?;
    queue_index(sql, &to, &org, Some("owner"), now)?;
    queue_index(sql, &caller.id, &org, Some("admin"), now)?;
    audit(
        sql,
        caller,
        "owner.transferred",
        &to,
        Some(json!({ "owner": caller.id }).to_string()),
        Some(json!({ "owner": to }).to_string()),
        now,
    )?;
    record_event(
        sql,
        "owner.transferred",
        &caller.id,
        None,
        &Transition::NONE,
        room_people(sql)?,
        now,
    )?;
    Ok(json!({ "owner": to }))
}

/// An organization's admin names a new owner for a room whose owner left. The caller checked who's asking, and that the
/// room records the departure. The former owner has no place in the room afterwards, unless they're the one named.
fn apply_recovery(
    sql: &SqlStorage,
    actor: &str,
    body: &Value,
    target_member: Option<&TargetMember>,
    now: i64,
) -> R<Value> {
    let room = rows(
        sql,
        "SELECT owner_person_id, owner_org_id, owner_left_at FROM workspace",
        vec![],
    )?;
    let room = room.first().ok_or_else(ApiError::workspace_not_found)?;
    let former = text(&room["owner_person_id"]).unwrap_or_default();
    let org = text(&room["owner_org_id"]).unwrap_or_default();
    // An admin outside the room can't read its policy version, so this is the check on an out-of-date view.
    if required(body, "expected_owner")? != former {
        return Err(ApiError::from_core(
            &podster_core::CoreError::VersionConflict,
        ));
    }
    let to = required(body, "to")?;
    require_id(&to)?;
    if to.starts_with(AGENT_ID_PREFIX) {
        return Err(ApiError::invalid_argument());
    }
    let joined = joined_org(target_member, &to, &org)?;
    set_owner(sql, &to, joined)?;
    if to != former {
        queue_index(sql, &former, &org, None, now)?;
    }
    queue_index(sql, &to, &org, Some("owner"), now)?;
    let caller = Caller {
        id: actor.to_string(),
        kind: PrincipalKind::Person,
        role: Role::None,
        scopes: Scopes::PUBLIC_PARTICIPANT,
    };
    audit(
        sql,
        &caller,
        "owner.recovered",
        &to,
        Some(json!({ "owner": former, "left_at": room["owner_left_at"] }).to_string()),
        Some(json!({ "owner": to }).to_string()),
        now,
    )?;
    record_event(
        sql,
        "owner.recovered",
        actor,
        None,
        &Transition::NONE,
        room_people(sql)?,
        now,
    )?;
    Ok(json!({ "owner": to }))
}

/// Clears a room's removal, so the agent can return through an invitation. It's the room's decision alone.
fn handle_clear_removal(
    sql: &SqlStorage,
    caller: &Caller,
    principal: &str,
    body: &Value,
    now: i64,
) -> R<Value> {
    ApiError::from_verdict(authorize_workroom(caller, WorkroomAction::ManageAccess))?;
    require_policy_version(sql, body)?;
    let found = rows(
        sql,
        "SELECT revocation_reason FROM member WHERE principal_id = ? AND revoked_at IS NOT NULL",
        vec![principal.into()],
    )?;
    if found.first().and_then(|m| m["revocation_reason"].as_str()) != Some("room_removed") {
        return Err(ApiError::invalid_argument());
    }
    exec(
        sql,
        "UPDATE member SET revocation_reason = 'removal_cleared' WHERE principal_id = ?",
        vec![principal.into()],
    )?;
    audit(
        sql,
        caller,
        "member.removal_cleared",
        principal,
        None,
        None,
        now,
    )?;
    Ok(json!({ "principal_id": principal, "status": "removal_cleared" }))
}

fn kind_name(caller: &Caller) -> &'static str {
    if caller.kind == PrincipalKind::Person {
        "person"
    } else {
        "agent"
    }
}

fn query_int(url: &Url, name: &str) -> R<Option<i64>> {
    match url.query_pairs().find(|(k, _)| k == name) {
        None => Ok(None),
        Some((_, v)) => v
            .parse()
            .map(Some)
            .map_err(|_| ApiError::invalid_argument()),
    }
}

fn query_str(url: &Url, name: &str) -> Option<String> {
    url.query_pairs()
        .find(|(k, _)| k == name)
        .map(|(_, v)| v.into_owned())
}

/// The query side. No writes, and every result passes through policy.
mod queries {
    use super::*;

    pub fn get_workspace(sql: &SqlStorage, who: &Participant) -> R<Value> {
        let caller = &who.caller;
        let room = rows(
            sql,
            "SELECT id, name, goal, context, brief_by, require_person_review, owner_person_id, owner_org_id, owner_left_at, status, policy_version FROM workspace",
            vec![],
        )?;
        let room = room.first().ok_or_else(ApiError::workspace_not_found)?;
        let members = if !sees_whole_room(caller) {
            rows(sql, "SELECT principal_id, kind, org_id, role, guest_can_create FROM member WHERE principal_id = ? AND revoked_at IS NULL", vec![caller.id.as_str().into()])?
        } else {
            rows(sql, "SELECT principal_id, kind, org_id, role, guest_can_create FROM member WHERE revoked_at IS NULL ORDER BY added_at", vec![])?
        };
        let manages = authorize_workroom(caller, WorkroomAction::ManageAccess) == Verdict::Allow;
        let mut listed = Vec::with_capacity(members.len());
        for m in &members {
            let mut entry = json!({
                "principal_id": m["principal_id"], "kind": m["kind"], "org_id": m["org_id"], "role": m["role"],
                "guest_can_create": int(&m["guest_can_create"]) != 0,
            });
            // Someone's scopes are for them and those who manage access.
            let id = m["principal_id"].as_str().unwrap_or_default();
            if manages || id == caller.id {
                let kind = m["kind"].as_str().map_or(PrincipalKind::Agent, parse_kind);
                let role = m["role"].as_str().map_or(Role::None, parse_role);
                entry["access"] = access_json(kind, role, store::granted_scopes(sql, id)?);
            }
            listed.push(entry);
        }
        let mut answer = json!({
            "id": room["id"], "name": room["name"], "owner": room["owner_person_id"], "status": room["status"],
            // Written by the room's owner or admins, and for reading only. `brief_external` marks it as another organization's.
            "require_person_review": int(&room["require_person_review"]) != 0,
            "goal": room["goal"], "context": room["context"], "brief_by": room["brief_by"], "brief_external": room["owner_org_id"].as_str() != Some(who.org.as_str()),
            "access": access_json(caller.kind, caller.role, caller.scopes),
            "policy_version": manages.then(|| room["policy_version"].clone()), "members": listed,
        });
        // Who has left and why, and which organization holds the room, are for those who manage its access.
        if manages {
            answer["owner_org"] = room["owner_org_id"].clone();
            answer["owner_left_at"] = room["owner_left_at"].clone();
            answer["removed"] = json!(rows(sql, "SELECT principal_id, kind, org_id, revoked_at, revocation_reason FROM member WHERE revoked_at IS NOT NULL ORDER BY revoked_at DESC LIMIT ?", vec![REMOVED_LISTED.into()])?);
        }
        Ok(answer)
    }

    /// What agents and people read to orient themselves, under the same check as the room read. It's text to read, never
    /// instructions, and `brief_external` marks it as another organization's.
    pub fn get_brief(sql: &SqlStorage, who: &Participant) -> R<Value> {
        let room = rows(
            sql,
            "SELECT name, goal, context, brief_by, owner_org_id FROM workspace",
            vec![],
        )?;
        let room = room.first().ok_or_else(ApiError::workspace_not_found)?;
        Ok(json!({
            "name": room["name"], "goal": room["goal"], "context": room["context"], "brief_by": room["brief_by"],
            "brief_external": room["owner_org_id"].as_str() != Some(who.org.as_str()),
        }))
    }

    /// A room's history, filtered for this viewer. It reads only, has no read state and never touches an inbox. The query
    /// itself is narrowed, so a page never comes back short because of what's hidden, and the cursor is an event's own
    /// random ID, so nothing here counts what the viewer can't see. Policy then re-checks each row.
    pub fn list_activity(sql: &SqlStorage, who: &Participant, url: &Url) -> R<Value> {
        let caller = &who.caller;
        let limit = query_int(url, "limit")?.unwrap_or(ACTIVITY_PAGE);
        if !(1..=ACTIVITY_PAGE).contains(&limit) {
            return Err(ApiError::invalid_argument());
        }
        // An event's own ID is the cursor, in either direction, so nothing here counts what the viewer can't see.
        let seq_of = |id: String| -> R<i64> {
            rows(
                sql,
                "SELECT seq FROM event WHERE id = ?",
                vec![id.as_str().into()],
            )?
            .first()
            .map(|row| int(&row["seq"]))
            .ok_or_else(ApiError::invalid_argument)
        };
        let (after, before) = (query_str(url, "after"), query_str(url, "before"));
        let order = query_str(url, "order");
        if order.as_deref().is_some_and(|value| value != "newest") {
            return Err(ApiError::invalid_argument());
        }
        let newest = before.is_some() || order.is_some();
        if newest && after.is_some() {
            return Err(ApiError::invalid_argument());
        }
        let edge = if newest {
            before.map_or(Ok(i64::MAX), seq_of)?
        } else {
            after.map_or(Ok(0), seq_of)?
        };
        let task_filter = query_str(url, "task");
        let actor_filter = query_str(url, "actor");
        let id = caller.id.as_str();
        // Someone who sees the whole room gets every task's and room's events. Otherwise, their own tasks, the room's
        // events for everyone, and what they did themselves.
        let mut query = "SELECT seq, id, type, actor_id, actor_org, task_id, reason, prior_status, new_status, created_at, subject_id FROM event WHERE seq COMPARE ?1 AND (?2 IS NULL OR task_id = ?2) AND (?3 IS NULL OR actor_id = ?3)".replace("COMPARE", if newest { "<" } else { ">" });
        let whole_room = sees_whole_room(caller);
        if !whole_room {
            let everyone = EVENTS_FOR_EVERYONE
                .map(|kind| format!("'{kind}'"))
                .join(", ");
            query.push_str(&format!(
                " AND type <> '{}'",
                podster_policy::TASK_PLAN_CHANGED
            ));
            // Notices about the viewer themselves, for those who get them. An old event names no subject, so it stays hidden.
            let about_themselves = if sees_notices_about_itself(caller) {
                let notices = podster_policy::NOTICES_ABOUT_SUBJECT
                    .map(|kind| format!("'{kind}'"))
                    .join(", ");
                format!(" OR (type IN ({notices}) AND subject_id = ?4)")
            } else {
                String::new()
            };
            query.push_str(&format!(" AND ((task_id IS NULL AND (type IN ({everyone}) OR actor_id = ?4{about_themselves})) OR task_id IN (SELECT id FROM task WHERE requester_id = ?4 OR assignee_id = ?4 OR reviewer_id = ?4))"));
        }
        query.push_str(if newest {
            " ORDER BY seq DESC"
        } else {
            " ORDER BY seq"
        });
        query.push_str(if whole_room { " LIMIT ?4" } else { " LIMIT ?5" });
        let mut bindings = vec![edge.into(), opt(&task_filter), opt(&actor_filter)];
        if !whole_room {
            bindings.push(id.into());
        }
        // One row past the page, which only says whether there is more, so a full last page doesn't promise another.
        bindings.push((limit + 1).into());
        let found = rows(sql, &query, bindings)?;
        let more = found.len() as i64 > limit;
        let mut events = Vec::with_capacity(found.len());
        let mut last = None;
        for row in found.iter().take(limit as usize) {
            let kind = row["type"].as_str().unwrap_or_default();
            let actor = row["actor_id"].as_str().unwrap_or_default();
            let task = match row["task_id"].as_str() {
                Some(task_id) => load_task(sql, task_id)?,
                None => None,
            };
            if !can_see_event(
                caller,
                kind,
                actor,
                task.as_ref(),
                row["subject_id"].as_str(),
            ) {
                continue;
            }
            // Only something the viewer may see becomes the cursor, even if the query and policy ever disagree.
            last = row["id"].as_str().map(str::to_string);
            // A reason is something someone wrote, so it follows the thread's scope, as in a task read.
            let reason = match &task {
                Some(task) if !task_view(caller, task).conversation => Value::Null,
                _ => row["reason"].clone(),
            };
            // Which organization holds the room is for those who see all of it, as in the room read. On a task, the
            // viewer already reads the same in its history.
            let from = if whole_room || task.is_some() {
                json!({ "id": actor, "org": row["actor_org"] })
            } else {
                json!({ "id": actor })
            };
            events.push(json!({
                "id": row["id"], "type": kind, "from": from,
                "external": row["actor_org"].as_str() != Some(who.org.as_str()),
                "task_id": row["task_id"], "task_title": task.as_ref().map(|t| t.title.clone()), "subject": row["subject_id"],
                "reason": reason, "prior_status": row["prior_status"], "new_status": row["new_status"], "created_at": row["created_at"],
            }));
        }
        let next = more.then_some(last).flatten();
        Ok(if newest {
            json!({ "events": events, "next_before": next })
        } else {
            json!({ "events": events, "next_after": next })
        })
    }

    /// Changes that were refused for lack of authority, newest first, for those who may read the audit log.
    pub fn list_denials(sql: &SqlStorage, caller: &Caller, url: &Url) -> R<Value> {
        ApiError::from_verdict(authorize_workroom(caller, WorkroomAction::ReadAuditLog))?;
        let offset = query_int(url, "offset")?.unwrap_or(0).max(0);
        let found = rows(sql, "SELECT day, actor_id, actor_kind, action, code, count, first_at, last_at, first_actor_id, last_actor_id FROM denial ORDER BY last_at DESC, rowid DESC LIMIT ? OFFSET ?",
            vec![(DENIALS_PAGE + 1).into(), offset.into()])?;
        let more = found.len() as i64 > DENIALS_PAGE;
        let denials: Vec<Value> = found.into_iter().take(DENIALS_PAGE as usize).map(|row| json!({
            "day_start": int(&row["day"]) * DAY_MS, "actor_id": row["actor_id"], "actor_kind": row["actor_kind"], "action": row["action"], "code": row["code"],
            "count": row["count"], "first_at": row["first_at"], "last_at": row["last_at"], "first_actor_id": row["first_actor_id"], "last_actor_id": row["last_actor_id"],
        })).collect();
        Ok(json!({ "denials": denials, "next_offset": more.then_some(offset + DENIALS_PAGE) }))
    }

    /// Invitations still usable, for those who manage access. The token was shown once and isn't kept.
    pub fn list_invitations(sql: &SqlStorage, caller: &Caller, now: i64) -> R<Value> {
        ApiError::from_verdict(authorize_workroom(caller, WorkroomAction::ManageAccess))?;
        let found = rows(sql, "SELECT id, invited_org_id, work_role_id, role, guest_can_create, created_by, created_at, expires_at FROM invitation WHERE status = 'pending' AND expires_at > ? ORDER BY created_at DESC LIMIT ?",
            vec![now.into(), (INVITATIONS_LISTED + 1).into()])?;
        let truncated = found.len() as i64 > INVITATIONS_LISTED;
        let invitations: Vec<Value> = found.into_iter().take(INVITATIONS_LISTED as usize).map(|row| json!({
            "id": row["id"], "invited_org_id": row["invited_org_id"], "work_role_id": row["work_role_id"], "role": row["role"], "guest_can_create": int(&row["guest_can_create"]) != 0,
            "created_by": row["created_by"], "created_at": row["created_at"], "expires_at": row["expires_at"],
        })).collect();
        Ok(json!({ "invitations": invitations, "truncated": truncated }))
    }

    pub fn list_tasks(sql: &SqlStorage, caller: &Caller, url: &Url) -> R<Value> {
        // Only a task the caller can see resumes a list. Any other answers as if it didn't exist.
        let cursor = super::cursor::resume(sql, url, "cursor", "task", "seq", None, |id| {
            Ok(load_task(sql, id)?.is_some_and(|task| can_see_task(caller, &task)))
        })?;
        let mine = query_str(url, "mine").as_deref() == Some("true");
        let status = query_str(url, "status");
        if let Some(s) = &status {
            if TaskStatus::from_name(s).is_none() {
                return Err(ApiError::invalid_argument());
            }
        }
        // Oldest first unless asked. Either way the list goes on past the cursor's task, or from before the first one.
        let order = query_str(url, "order");
        let (comparison, direction, start) = match order.as_deref() {
            None | Some("oldest") => (">", "ASC", 0),
            Some("newest") => ("<", "DESC", i64::MAX),
            Some(_) => return Err(ApiError::invalid_argument()),
        };
        let from = match cursor {
            super::cursor::Resume::Start => start,
            super::cursor::Resume::After(seq) => seq,
        };
        // Someone limited to their own tasks only ever receives those, so the query itself is narrowed before policy re-checks each row.
        let narrow = mine || !sees_whole_room(caller);
        let query = format!("SELECT *, seq AS position FROM task WHERE seq {comparison} ? AND (? IS NULL OR status = ?)
            AND (? = 0 OR requester_id = ? OR assignee_id = ? OR reviewer_id = ?) ORDER BY seq {direction} LIMIT ?");
        let (tasks, next) = super::cursor::page(
            sql,
            from,
            |position| {
                rows(
                    sql,
                    &query,
                    vec![
                        position.into(),
                        opt(&status),
                        opt(&status),
                        i64::from(narrow).into(),
                        caller.id.as_str().into(),
                        caller.id.as_str().into(),
                        caller.id.as_str().into(),
                        (PAGE_SIZE + 1).into(),
                    ],
                )
            },
            |row| {
                let task = store::task_from_row(row)?;
                Ok(can_see_task(caller, &task).then(|| task_json(&task)))
            },
        )?;
        Ok(json!({ "tasks": tasks, "next_cursor": next }))
    }

    fn message_json(row: &Value, reader_org: &str) -> Value {
        json!({
            "id": row["id"], "from": { "id": row["sender_id"], "org": row["sender_org"] },
            "external": row["sender_org"].as_str() != Some(reader_org), "body": row["body"], "created_at": row["created_at"],
        })
    }

    /// `oversight` narrows what it shows of files to name and status, for an organization's admin reading as their agent.
    pub fn get_task(sql: &SqlStorage, who: &Participant, id: &str, oversight: bool) -> R<Value> {
        let task = load_task(sql, id)?.ok_or_else(ApiError::task_not_found)?;
        ApiError::from_verdict(authorize_task(&who.caller, &task, TaskAction::Read))?;
        let view = task_view(&who.caller, &task);
        // A narrow artifact scope leaves only what the caller submitted, so nothing else's note or link reaches them.
        let readable = |row: &&Value| {
            view.artifacts == ArtifactView::All
                || row["submitted_by"].as_str() == Some(who.caller.id.as_str())
        };
        let artifacts = rows(sql, "SELECT id, submission_no, uri, label, submitted_by, submitted_org, created_at FROM artifact WHERE task_id = ? ORDER BY submission_no, id", vec![id.into()])?;
        let artifacts: Vec<Value> = artifacts.iter().filter(readable).map(|a| json!({
            "id": a["id"], "submission_no": a["submission_no"], "uri": a["uri"], "label": a["label"],
            "from": { "id": a["submitted_by"], "org": a["submitted_org"] },
            "external": a["submitted_org"].as_str() != Some(who.org.as_str()), "created_at": a["created_at"],
        })).collect();
        let submissions = rows(sql, "SELECT submission_no, task_version, note, commit_sha, submitted_by, submitted_org, created_at FROM submission WHERE task_id = ? ORDER BY submission_no", vec![id.into()])?;
        let mut messages = rows(
            sql,
            "SELECT * FROM message WHERE task_id = ? ORDER BY seq DESC LIMIT 20",
            vec![id.into()],
        )?;
        messages.reverse();
        if !view.conversation {
            messages.clear();
        }
        let messages: Vec<Value> = messages.iter().map(|m| message_json(m, &who.org)).collect();
        // In order, without saying where each entry sits among the room's events, which would count the ones not shown.
        let history = rows(sql, "SELECT id, type, actor_id, actor_org, reason, prior_status, new_status, task_version, created_at FROM event WHERE task_id = ?1 AND (type <> ?2 OR ?3) ORDER BY seq", vec![id.into(), podster_policy::TASK_PLAN_CHANGED.into(), flag(sees_whole_room(&who.caller))])?;
        let marked = |row: &Value, id: &str, org: &str| -> Value {
            let mut out = row.clone();
            if let Some(map) = out.as_object_mut() {
                map.insert("from".into(), json!({ "id": row[id], "org": row[org] }));
                map.insert(
                    "external".into(),
                    json!(row[org].as_str() != Some(who.org.as_str())),
                );
                // A history entry's reason is something someone wrote, so it follows the thread's scope.
                if !view.conversation && map.contains_key("reason") {
                    map.insert("reason".into(), Value::Null);
                }
            }
            out
        };
        let submissions: Vec<Value> = submissions
            .iter()
            .filter(readable)
            .map(|r| marked(r, "submitted_by", "submitted_org"))
            .collect();
        let history: Vec<Value> = history
            .iter()
            .map(|r| marked(r, "actor_id", "actor_org"))
            .collect();
        let files = super::submission_files::for_task(sql, who, &task, oversight)?;
        Ok(json!({
            "task": task_json(&task), "expected_output": super::outputs::of_task(sql, &task.id, oversight)?, "submissions": submissions, "artifacts": artifacts, "files": files, "messages": messages, "history": history,
            // Says what's limited, so empty lists and null reasons aren't read as "none exist".
            "visible": { "submissions": if view.artifacts == ArtifactView::All { "all" } else { "own" }, "conversation": view.conversation },
        }))
    }

    pub fn list_messages(sql: &SqlStorage, who: &Participant, id: &str, url: &Url) -> R<Value> {
        let task = load_task(sql, id)?.ok_or_else(ApiError::task_not_found)?;
        ApiError::from_verdict(authorize_task(&who.caller, &task, TaskAction::Read))?;
        if !task_view(&who.caller, &task).conversation {
            return Err(ApiError::not_allowed());
        }
        // The last message the page before returned, by its ID and on this task. A message's place in the room would count the
        // messages on tasks the reader can't see.
        let after = match super::cursor::resume(
            sql,
            url,
            "after",
            "message",
            "seq",
            Some(("task_id", id)),
            // The thread is all-or-nothing for whoever reads it, so any message on it may resume it.
            |_| Ok(true),
        )? {
            super::cursor::Resume::Start => 0,
            super::cursor::Resume::After(seq) => seq,
        };
        let found = rows(
            sql,
            "SELECT * FROM message WHERE task_id = ? AND seq > ? ORDER BY seq LIMIT ?",
            vec![id.into(), after.into(), PAGE_SIZE.into()],
        )?;
        Ok(
            json!({ "messages": found.iter().map(|m| message_json(m, &who.org)).collect::<Vec<_>>() }),
        )
    }

    pub fn list_events(sql: &SqlStorage, caller: &Caller, url: &Url) -> R<Value> {
        ApiError::from_verdict(authorize_workroom(caller, WorkroomAction::ReadAuditLog))?;
        let after = query_int(url, "after")?.unwrap_or(0);
        let events = rows(sql, "SELECT seq, id, type, actor_id, actor_org, task_id, reason, prior_status, new_status, task_version, created_at FROM event WHERE seq > ? ORDER BY seq LIMIT ?", vec![after.into(), PAGE_SIZE.into()])?;
        Ok(json!({ "events": events }))
    }

    pub fn list_audit(sql: &SqlStorage, caller: &Caller, url: &Url) -> R<Value> {
        ApiError::from_verdict(authorize_workroom(caller, WorkroomAction::ReadAuditLog))?;
        let after = query_int(url, "after")?.unwrap_or(0);
        let mut audit = rows(sql, "SELECT id, actor_id, actor_kind, action, target_id, outcome, reason_code, prior_json, new_json, policy_version, seq, created_at
            FROM audit_event WHERE seq > ? ORDER BY seq LIMIT ?", vec![after.into(), (PAGE_SIZE + 1).into()])?;
        // One row past the page, which only says whether there is more, so a full last page doesn't lead to an empty one.
        let more = audit.len() as i64 > PAGE_SIZE;
        audit.truncate(PAGE_SIZE as usize);
        let next = more.then(|| audit.last().map(|r| int(&r["seq"]))).flatten();
        // The cursor is the entry's place in the list. It isn't part of the entry.
        for entry in &mut audit {
            if let Some(fields) = entry.as_object_mut() {
                fields.remove("seq");
            }
        }
        Ok(json!({ "audit": audit, "next_cursor": next }))
    }
}

#[durable_object]
pub struct Workspace {
    state: State,
    env: Env,
    /// Test builds only: pretends a join started at an older generation.
    test_generation: RefCell<Option<u64>>,
    /// Refusals not yet written. They wait here so the answer to a refusal does the same work for a real room and an
    /// unknown one, and repeats cost nothing. A restart loses them.
    denials_held: RefCell<HeldDenials>,
    /// Whether an alarm is set for what's held, so a failure to set one is tried again on the next refusal.
    denial_alarm_set: std::cell::Cell<bool>,
    /// File sweeps that failed in a row, which backs off how soon the alarm comes back for them. A restart forgets it.
    sweep_failures: std::cell::Cell<u32>,
    /// Whether nothing is held from a failed migration, so a request needn't look. A restart looks again.
    held_clear: std::cell::Cell<bool>,
}

type HeldDenials = std::collections::HashMap<DenialKey, HeldDenial>;

#[derive(Clone, PartialEq, Eq, Hash)]
struct DenialKey {
    actor: String,
    kind: String,
    action: &'static str,
    code: &'static str,
}

#[derive(Clone)]
struct HeldDenial {
    count: i64,
    first_at: i64,
    last_at: i64,
}

/// What this actor's earlier request with this key was answered, if it's the same request.
fn stored_answer(
    sql: &SqlStorage,
    actor: &str,
    key: &str,
    hash: &str,
    now: i64,
) -> R<Option<Value>> {
    let prior = rows(sql, "SELECT request_hash, response_json FROM idempotency WHERE actor_id = ? AND key = ? AND expires_at > ?",
        vec![actor.into(), key.into(), now.into()])?;
    let Some(prior) = prior.first() else {
        return Ok(None);
    };
    if prior["request_hash"].as_str() != Some(hash) {
        return Err(ApiError::idempotency_mismatch());
    }
    Ok(Some(serde_json::from_str(
        prior["response_json"].as_str().unwrap_or("null"),
    )?))
}

/// Keeps a command's answer for a retry. A secret in a response is returned once and never stored, so a replay can't reveal it.
fn store_answer(
    sql: &SqlStorage,
    actor: &str,
    key: &str,
    hash: &str,
    value: &Value,
    now: i64,
) -> R<()> {
    let mut stored = value.clone();
    if let Some(map) = stored.as_object_mut() {
        map.remove("token");
    }
    exec(sql, "INSERT OR REPLACE INTO idempotency (actor_id, key, request_hash, response_json, expires_at) VALUES (?, ?, ?, ?, ?)", vec![
        actor.into(), key.into(), hash.into(), stored.to_string().into(), (now + IDEMPOTENCY_TTL_MS).into(),
    ])
}

impl Workspace {
    /// Runs one command: authority, replay check, handler and idempotency record commit or roll back together.
    fn command(
        &self,
        identity: &Identity,
        key: Option<String>,
        hash: String,
        stops_when_archived: bool,
        test_fail: bool,
        handler: impl FnOnce(&SqlStorage, &Participant, i64) -> R<Value> + 'static,
    ) -> R<Value> {
        self.command_checked(
            identity,
            key,
            hash,
            stops_when_archived,
            test_fail,
            |_, _| Ok(()),
            handler,
        )
    }

    /// The same, with `recheck` run before a stored answer is replayed, for a command whose own authority goes past being in the
    /// room. A stored answer then can't reach someone who has since lost it. Removal and setting a task's output use it.
    #[allow(clippy::too_many_arguments)]
    fn command_checked(
        &self,
        identity: &Identity,
        key: Option<String>,
        hash: String,
        stops_when_archived: bool,
        test_fail: bool,
        recheck: impl FnOnce(&SqlStorage, &Participant) -> R<()> + 'static,
        handler: impl FnOnce(&SqlStorage, &Participant, i64) -> R<Value> + 'static,
    ) -> R<Value> {
        let key = key
            .filter(|k| !k.is_empty() && k.len() <= MAX_KEY_BYTES)
            .ok_or_else(ApiError::idempotency_required)?;
        let sql = self.state.storage().sql();
        let identity = identity.clone();
        let out: Rc<RefCell<Option<Value>>> = Rc::new(RefCell::new(None));
        let slot = out.clone();
        transaction_sync(&self.state, move || {
            // Authority first, so a revoked caller can't replay a stored response.
            let who = resolve_caller(&sql, &identity)?;
            recheck(&sql, &who)?;
            let now = now_ms();
            if let Some(answer) = stored_answer(&sql, &identity.id, &key, &hash, now)? {
                *slot.borrow_mut() = Some(answer);
                return Ok(());
            }
            if stops_when_archived && room_archived(&sql)? {
                return Err(ApiError::workspace_archived());
            }
            let value = handler(&sql, &who, now)?;
            store_answer(&sql, &identity.id, &key, &hash, &value, now)?;
            #[cfg(feature = "failpoints")]
            if test_fail {
                return Err(ApiError::internal("injected failure"));
            }
            #[cfg(not(feature = "failpoints"))]
            let _ = test_fail;
            *slot.borrow_mut() = Some(value);
            Ok(())
        })?;
        let value = out.borrow_mut().take();
        value.ok_or_else(|| ApiError::internal("command produced no result"))
    }

    /// Runs ownership recovery, for someone who may have no role in this room, so it can't go through `command`. An
    /// organization's admin outside the room is told nothing until the room records that its owner left, so a refusal
    /// can't confirm that the room exists or who owns it. Their own retry gets its stored answer, even though recovery
    /// has cleared that record, and keys are per actor. It works in an archived room, which nobody could otherwise bring back.
    fn recover_owner(
        &self,
        identity: &Identity,
        key: Option<String>,
        hash: String,
        body: Value,
        test_fail: bool,
    ) -> R<Value> {
        let sql = self.state.storage().sql();
        let identity = identity.clone();
        let out: Rc<RefCell<Option<Value>>> = Rc::new(RefCell::new(None));
        let slot = out.clone();
        transaction_sync(&self.state, move || {
            let now = now_ms();
            let org = room_owner_org(&sql)?;
            if !may_recover_ownership(
                parse_kind(&identity.kind),
                identity.admin_orgs.contains(&org),
            ) {
                // An outsider learns nothing, and someone in the room is told no.
                resolve_caller(&sql, &identity)?;
                return Err(ApiError::not_allowed());
            }
            let key = key.filter(|k| !k.is_empty() && k.len() <= MAX_KEY_BYTES);
            if let Some(key) = &key {
                if let Some(answer) = stored_answer(&sql, &identity.id, key, &hash, now)? {
                    *slot.borrow_mut() = Some(answer);
                    return Ok(());
                }
            }
            let room = rows(&sql, "SELECT owner_left_at FROM workspace", vec![])?;
            if room
                .first()
                .is_none_or(|room| room["owner_left_at"].is_null())
            {
                resolve_caller(&sql, &identity)?;
                return Err(ApiError::not_allowed());
            }
            let key = key.ok_or_else(ApiError::idempotency_required)?;
            let value = apply_recovery(
                &sql,
                &identity.id,
                &body,
                identity.target_member.as_ref(),
                now,
            )?;
            store_answer(&sql, &identity.id, &key, &hash, &value, now)?;
            #[cfg(feature = "failpoints")]
            if test_fail {
                return Err(ApiError::internal("injected failure"));
            }
            #[cfg(not(feature = "failpoints"))]
            let _ = test_fail;
            *slot.borrow_mut() = Some(value);
            Ok(())
        })?;
        let value = out.borrow_mut().take();
        value.ok_or_else(|| ApiError::internal("recovery produced no result"))
    }

    /// Applies a global disconnect in this room, and always leaves the floor behind, even for a non-member,
    /// so a join begun before the disconnect can't commit after this room acknowledges it.
    fn fence(&self, principal: String, floor: i64) -> R<Value> {
        let sql = self.state.storage().sql();
        if !store::is_initialized(&sql)? {
            return Ok(json!({ "acked": true }));
        }
        if self.migrate_if_needed().is_err() {
            let body = json!({ "principal": principal, "floor": floor });
            return self.hold(held::HELD_FENCE, body, json!({ "acked": true }));
        }
        transaction_sync(&self.state, move || {
            fence_effect(&sql, &principal, floor, now_ms())
        })?;
        Ok(json!({ "acked": true }))
    }

    /// Lets an agent's own organization withdraw it, or consent to its return, without any room authority.
    /// Returns `None` when this caller isn't that agent's owner, so the normal authority path answers instead.
    fn agent_owner_action(&self, identity: &Identity, agent: &str, verb: &str) -> R<Option<Value>> {
        let sql = self.state.storage().sql();
        let found = rows(&sql, "SELECT org_id, revoked_at, revocation_reason FROM member WHERE principal_id = ? AND kind = 'agent'", vec![agent.into()])?;
        let Some(member) = found.first() else {
            return Ok(None);
        };
        let is_owner = identity.kind == "person"
            && member["org_id"]
                .as_str()
                .is_some_and(|org| identity.admin_orgs.iter().any(|o| o == org));
        if !is_owner {
            return Ok(None);
        }
        let (agent, actor, verb, active) = (
            agent.to_string(),
            identity.id.clone(),
            verb.to_string(),
            member["revoked_at"].is_null(),
        );
        transaction_sync(&self.state, move || {
            let now = now_ms();
            let person = Caller {
                id: actor.clone(),
                kind: PrincipalKind::Person,
                role: Role::None,
                scopes: Scopes::PUBLIC_PARTICIPANT,
            };
            if verb == "withdraw" && active {
                remove_member(&sql, &person, "person", &agent, "owner_withdrawn", now)?;
            } else if verb == "owner-consent" && !active {
                exec(
                    &sql,
                    "UPDATE member SET owner_consented_at = ? WHERE principal_id = ?",
                    vec![now.into(), agent.as_str().into()],
                )?;
                audit_as(
                    &sql,
                    &actor,
                    "person",
                    "member.owner_consented",
                    &agent,
                    None,
                    None,
                    now,
                )?;
            }
            Ok(())
        })?;
        Ok(Some(json!({ "status": "ok" })))
    }

    /// What a link offers, for the person holding it. It needs the secret, and every failure looks the same.
    fn preview_invitation(&self, identity: &Identity, body: &Value) -> R<Value> {
        let sql = self.state.storage().sql();
        let token = required(body, "token").map_err(|_| ApiError::invitation_not_found())?;
        let (id, secret) = parse_token(&token).ok_or_else(ApiError::invitation_not_found)?;
        if !store::is_initialized(&sql)? {
            return Err(ApiError::invitation_not_found());
        }
        self.migrate_if_needed()?;
        let invitation = find_invitation(&sql, &id, &secret, now_ms())?
            .filter(|row| row["status"].as_str() == Some("pending"))
            .ok_or_else(ApiError::invitation_not_found)?;
        // A link naming an organization is for that organization's people. Anyone in an organization revoked since the link
        // was made learns nothing, like any other bad link.
        let invited = invitation["invited_org_id"].as_str();
        if invited.is_some_and(|org| !in_org(identity, org)) {
            return Err(ApiError::invitation_not_found());
        }
        for org in identity.orgs.iter().chain([&identity.org]) {
            if barred_by_revocation(&sql, org, &invitation)? {
                return Err(ApiError::invitation_not_found());
            }
        }
        let room = rows(&sql, "SELECT id, name, owner_org_id FROM workspace", vec![])?;
        let room = room.first().ok_or_else(ApiError::invitation_not_found)?;
        // The opening a link names, so whoever decides can see what it would mean. A closed one is no longer on offer.
        let work_role = rows(
            &sql,
            "SELECT id, title, responsibilities, capacity, preset, is_lead FROM work_role WHERE id = ? AND closed_at IS NULL",
            vec![invitation["work_role_id"].as_str().unwrap_or_default().into()],
        )?
        .into_iter()
        .next()
        .map(|mut role| {
            // Whose words these are, without saying which organization holds the room.
            role["external"] = json!(!room["owner_org_id"].as_str().is_some_and(|org| in_org(identity, org)));
            role
        });
        Ok(json!({
            "workspace_id": room["id"], "workspace_name": room["name"], "work_role": work_role,
            "role": invitation["role"], "guest_can_create": int(&invitation["guest_can_create"]) != 0,
            "invited_org_id": invitation["invited_org_id"], "invited_by": invitation["created_by"], "expires_at": invitation["expires_at"],
        }))
    }

    /// Accepts an invitation for agents of the caller's organization. Both sides are people.
    async fn accept_invitation(&self, identity: &Identity, body: &Value) -> R<Value> {
        let sql = self.state.storage().sql();
        if identity.kind != "person" {
            return Err(ApiError::not_allowed());
        }
        if !store::is_initialized(&sql)? {
            return Err(ApiError::invitation_not_found());
        }
        self.migrate_if_needed()?;
        let token = required(body, "token")?;
        let (id, secret) = parse_token(&token).ok_or_else(ApiError::invitation_not_found)?;
        let now = now_ms();
        let invitation =
            find_invitation(&sql, &id, &secret, now)?.ok_or_else(ApiError::invitation_not_found)?;
        let org = required(body, "org_id")?;
        let mut agents: Vec<String> = body
            .get("agents")
            .and_then(Value::as_array)
            .ok_or_else(ApiError::invalid_argument)?
            .iter()
            .map(|a| {
                a.as_str()
                    .map(str::to_string)
                    .ok_or_else(ApiError::invalid_argument)
            })
            .collect::<R<_>>()?;
        agents.sort();
        agents.dedup();
        let request = json!({ "org_id": org, "agents": agents }).to_string();
        // A retry of the same request by the same person gets the first answer, so a lost response is safe.
        let replay = |row: &Value| -> R<Option<Value>> {
            if row["status"].as_str() != Some("accepted") {
                return Ok(None);
            }
            if row["accepted_by"].as_str() == Some(identity.id.as_str())
                && row["accepted_request"].as_str() == Some(request.as_str())
            {
                return Ok(Some(serde_json::from_str(
                    row["accepted_response"].as_str().unwrap_or("null"),
                )?));
            }
            Err(ApiError::invitation_not_found())
        };
        if let Some(answer) = replay(&invitation)? {
            return Ok(answer);
        }
        if barred_by_revocation(&sql, &org, &invitation)? {
            return Err(ApiError::invitation_not_found());
        }
        if !identity.admin_orgs.contains(&org)
            || invitation["invited_org_id"]
                .as_str()
                .is_some_and(|o| o != org)
        {
            return Err(ApiError::not_allowed());
        }
        if agents.is_empty() || agents.len() > MAX_ACCEPT_AGENTS {
            return Err(ApiError::invalid_argument());
        }
        let test_generation = if cfg!(feature = "failpoints") {
            self.test_generation.borrow().to_owned()
        } else {
            None
        };
        let mut registered = Vec::new();
        for agent in &agents {
            require_id(agent)?;
            // One answer whether the agent is unknown, elsewhere or disconnected, so IDs can't be probed here.
            let generation =
                principal::register_room(&self.env, agent, &org, &identity.workspace_id, false)
                    .await?;
            registered.push((agent.clone(), test_generation.unwrap_or(generation)));
        }
        let person = identity.id.clone();
        let out: Rc<RefCell<Option<Value>>> = Rc::new(RefCell::new(None));
        let slot = out.clone();
        transaction_sync(&self.state, move || {
            let now = now_ms();
            let found = find_invitation(&sql, &id, &secret, now)?
                .ok_or_else(ApiError::invitation_not_found)?;
            if found["status"].as_str() == Some("accepted") {
                if found["accepted_by"].as_str() == Some(person.as_str())
                    && found["accepted_request"].as_str() == Some(request.as_str())
                {
                    *slot.borrow_mut() = Some(serde_json::from_str(
                        found["accepted_response"].as_str().unwrap_or("null"),
                    )?);
                    return Ok(());
                }
                return Err(ApiError::invitation_not_found());
            }
            // Again here, so a revocation that committed since the check above still holds.
            if barred_by_revocation(&sql, &org, &found)? {
                return Err(ApiError::invitation_not_found());
            }
            let role = text(&found["role"]).unwrap_or_else(|| "guest".to_string());
            let guest_can_create = role == "guest" && int(&found["guest_can_create"]) != 0;
            let actor = Caller {
                id: person.clone(),
                kind: PrincipalKind::Person,
                role: Role::None,
                scopes: Scopes::PUBLIC_PARTICIPANT,
            };
            let mut joined = Vec::new();
            for (agent, generation) in &registered {
                if is_owner(&sql, agent)? {
                    return Err(ApiError::not_allowed());
                }
                require_past_fence(&sql, agent, *generation)?;
                let existing = rows(&sql, "SELECT kind, org_id, revoked_at, revocation_reason FROM member WHERE principal_id = ?", vec![agent.as_str().into()])?;
                let mut returning = false;
                let prior_scopes = store::granted_scopes(&sql, agent)?;
                if let Some(row) = existing.first() {
                    if row["revoked_at"].is_null() {
                        continue;
                    }
                    // An invitation can't undo the room's decision or take over another identity.
                    if row["revocation_reason"].as_str() == Some("room_removed")
                        || row["kind"].as_str() != Some("agent")
                        || row["org_id"].as_str() != Some(org.as_str())
                    {
                        return Err(ApiError::not_allowed());
                    }
                    returning = true;
                }
                if active_count(&sql)? + 1 >= MAX_MEMBERS {
                    return Err(ApiError::limit_exceeded());
                }
                write_member(
                    &sql,
                    &person,
                    agent,
                    "agent",
                    &org,
                    &role,
                    guest_can_create,
                    Some(*generation),
                    now,
                )?;
                // The agent's own organization is bringing it back, and that organization has no authority in this
                // room, so it can't undo what the room narrowed. A room's owner or admin can widen it again.
                let parsed_role = parse_role(&role);
                let mut scopes = Scopes::for_role(parsed_role, guest_can_create);
                if returning {
                    scopes = prior_scopes.narrower(scopes);
                    store::write_grant(&sql, agent, scopes, &person, now)?;
                    exec(
                        &sql,
                        "UPDATE member SET guest_can_create = ? WHERE principal_id = ?",
                        vec![
                            flag(guest_can_create && scopes.tasks.can_create()),
                            agent.as_str().into(),
                        ],
                    )?;
                    objects::drop_uploads_no_longer_allowed(&sql, &person, "person", agent, now)?;
                }
                let access = access_json(PrincipalKind::Agent, parsed_role, scopes);
                audit(
                    &sql,
                    &actor,
                    "member.added",
                    agent,
                    returning.then(|| json!({ "revoked": true, "access": access_json(PrincipalKind::Agent, parsed_role, prior_scopes) }).to_string()),
                    Some(
                        json!({ "role": role, "kind": "agent", "org_id": org, "invitation": id, "access": access })
                            .to_string(),
                    ),
                    now,
                )?;
                store::record_event_about(
                    &sql,
                    "member.added",
                    &person,
                    Some(agent),
                    None,
                    &Transition::NONE,
                    [agent.clone()],
                    now,
                )?;
                // A first-time joiner may claim the opening the link names. An agent coming back gets no invite from
                // its own organization's acceptance, because a claim could otherwise undo what the room narrowed.
                if !returning {
                    if let Some(work_role) = found["work_role_id"].as_str() {
                        let open = !rows(
                            &sql,
                            "SELECT id FROM work_role WHERE id = ? AND closed_at IS NULL",
                            vec![work_role.into()],
                        )?
                        .is_empty();
                        if open {
                            // The room's person made the offer, not the one accepting, and a claim rechecks them.
                            let offered_by = text(&found["created_by"]).unwrap_or_default();
                            roles::add_invite(&sql, &actor, &offered_by, work_role, agent, now)?;
                        }
                    }
                }
                joined.push(agent.clone());
            }
            // Accepting for agents already here changes nothing, so it doesn't use up the invitation.
            if joined.is_empty() {
                return Err(ApiError::already_member());
            }
            let response = json!({ "status": "accepted", "agents": joined });
            exec(&sql, "UPDATE invitation SET status = 'accepted', accepted_by = ?, accepted_request = ?, accepted_response = ? WHERE id = ?",
                vec![person.as_str().into(), request.as_str().into(), response.to_string().into(), id.as_str().into()])?;
            *slot.borrow_mut() = Some(response);
            Ok(())
        })?;
        let response = out.borrow_mut().take();
        response.ok_or_else(|| ApiError::internal("no result"))
    }

    /// Writes queued listing updates to D1. They're ordered by `seq`, so a retry can't restore older data.
    async fn drain_index(&self) -> R<()> {
        let sql = self.state.storage().sql();
        if !store::is_initialized(&sql)? {
            return Ok(());
        }
        let room = rows(
            &sql,
            "SELECT id, name, status, owner_person_id, owner_left_at FROM workspace",
            vec![],
        )?;
        let Some(room) = room.first() else {
            return Ok(());
        };
        let pending = rows(&sql, "SELECT seq, principal_id, org_id, role, removed FROM index_outbox ORDER BY seq LIMIT 100", vec![])?;
        let db = self.env.d1("DB")?;
        for row in &pending {
            // The room's name and status as they are now aren't for someone already out.
            let removed = int(&row["removed"]) != 0;
            let args: Vec<JsValue> = vec![
                room["id"].as_str().unwrap_or("").into(),
                row["principal_id"].as_str().unwrap_or("").into(),
                row["org_id"].as_str().unwrap_or("").into(),
                row["role"].as_str().map_or(JsValue::NULL, JsValue::from),
                if removed {
                    ""
                } else {
                    room["name"].as_str().unwrap_or("")
                }
                .into(),
                JsValue::from_f64(int(&row["removed"]) as f64),
                JsValue::from_f64(int(&row["seq"]) as f64),
                room["status"].as_str().unwrap_or(ACTIVE_ROOM).into(),
                // Only the owner's row says the owner left, and it reads the room as it is now.
                match room["owner_left_at"].as_i64() {
                    Some(left_at) if !removed && row["principal_id"] == room["owner_person_id"] => {
                        JsValue::from_f64(left_at as f64)
                    }
                    _ => JsValue::NULL,
                },
            ];
            db.prepare("INSERT INTO membership_index (workspace_id, principal_id, org_id, role, workspace_name, removed, updated_seq, workspace_status, owner_left_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT (workspace_id, principal_id) DO UPDATE SET org_id = excluded.org_id, role = excluded.role, owner_left_at = excluded.owner_left_at,
                workspace_name = CASE WHEN excluded.removed = 1 THEN membership_index.workspace_name ELSE excluded.workspace_name END,
                workspace_status = CASE WHEN excluded.removed = 1 THEN membership_index.workspace_status ELSE excluded.workspace_status END,
                removed = excluded.removed, updated_seq = excluded.updated_seq WHERE excluded.updated_seq > membership_index.updated_seq")
                .bind(&args)?.run().await?;
            exec(
                &sql,
                "DELETE FROM index_outbox WHERE seq = ?",
                vec![int(&row["seq"]).into()],
            )?;
        }
        if !rows(&sql, "SELECT seq FROM index_outbox LIMIT 1", vec![])?.is_empty() {
            self.state
                .storage()
                .set_alarm(std::time::Duration::from_millis(100))
                .await?;
        }
        Ok(())
    }

    /// Delivers queued events to each recipient's Principal, in order per recipient. A recipient that fails waits, so
    /// a later event can't overtake it. Rows go only after delivery, and delivery is idempotent, so a crash at any point
    /// resends rather than loses.
    async fn drain_outbox(&self) -> R<()> {
        let sql = self.state.storage().sql();
        if !store::is_initialized(&sql)? || outbox_held(&sql)? {
            return Ok(());
        }
        // A recipient may be someone whose removal is held, which applying it would delete from the outbox. So nothing goes
        // until the room migrates and replays, and the alarm comes back on the outbox's failure delay.
        if self.access_changes_pending(&sql)? {
            return Err(ApiError::api(503, "room_migration_pending"));
        }
        let room = rows(&sql, "SELECT id FROM workspace", vec![])?;
        let Some(workspace_id) = room.first().and_then(|r| text(&r["id"])) else {
            return Ok(());
        };
        let now = Date::now().as_millis() as i64;
        let pending = rows(&sql, "SELECT o.event_id, o.recipient_principal_id, o.attempts, e.seq, e.type, e.actor_id, e.task_id, e.created_at
          FROM outbox o JOIN event e ON e.id = o.event_id
          WHERE o.recipient_principal_id NOT IN (SELECT recipient_principal_id FROM outbox WHERE next_attempt_at > ?)
          ORDER BY e.seq LIMIT ?", vec![now.into(), OUTBOX_BATCH.into()])?;
        let mut waiting: Vec<String> = Vec::new();
        for row in &pending {
            let recipient = text(&row["recipient_principal_id"]).unwrap_or_default();
            if waiting.contains(&recipient) {
                continue;
            }
            let event_id = text(&row["event_id"]).unwrap_or_default();
            let key = vec![V::from(event_id.as_str()), V::from(recipient.as_str())];
            // A revocation can commit during an earlier await here, and it deletes this recipient's rows.
            let still_queued = rows(
                &sql,
                "SELECT event_id FROM outbox WHERE event_id = ? AND recipient_principal_id = ?",
                key.clone(),
            )?;
            if still_queued.is_empty() {
                continue;
            }
            let body = json!({ "event_id": event_id, "event_seq": row["seq"], "workspace_id": workspace_id, "type": row["type"], "actor_id": row["actor_id"], "task_id": row["task_id"], "created_at": row["created_at"] });
            if send_to_inbox(&self.env, &recipient, &body).await {
                exec(
                    &sql,
                    "DELETE FROM outbox WHERE event_id = ? AND recipient_principal_id = ?",
                    key,
                )?;
            } else {
                let attempts = int(&row["attempts"]) + 1;
                let delay = (1000_i64 << attempts.min(9)).min(OUTBOX_MAX_BACKOFF_MS);
                exec(&sql, "UPDATE outbox SET attempts = ?, next_attempt_at = ? WHERE event_id = ? AND recipient_principal_id = ?", vec![
                    attempts.into(),
                    (Date::now().as_millis() as i64 + delay).into(),
                    event_id.as_str().into(),
                    recipient.as_str().into(),
                ])?;
                waiting.push(recipient);
            }
        }
        Ok(())
    }

    /// Puts this room's new A2A offer attempts on the A2A queue. Nothing goes while the room needs migrating.
    async fn drain_a2a(&self) -> R<()> {
        let sql = self.state.storage().sql();
        // Held with the event outbox, so a test that holds delivery holds this too, and the alarm isn't due for it meanwhile.
        if !store::is_initialized(&sql)? || store::needs_migration(&sql)? || outbox_held(&sql)? {
            return Ok(());
        }
        let Some(workspace_id) = rows(&sql, "SELECT id FROM workspace", vec![])?
            .first()
            .and_then(|r| text(&r["id"]))
        else {
            return Ok(());
        };
        a2a_out::drain(
            &self.env,
            &sql,
            &workspace_id,
            Date::now().as_millis() as i64,
        )
        .await
    }

    /// Schedules the alarm for whatever is due next, moving it earlier if needed. Never later: a pending alarm that
    /// finds nothing to do costs nothing, and a missed one would strand events.
    async fn arm(&self, index_failed: bool, outbox_failed: bool) -> R<()> {
        let sql = self.state.storage().sql();
        if !store::is_initialized(&sql)? {
            return Ok(());
        }
        // Scheduling doesn't migrate a room. A request does, and then arms, so an unmigrated room has no scans to end until then.
        let migrated = !store::needs_migration(&sql)?;
        let now = Date::now().as_millis() as i64;
        let mut due: Option<i64> = None;
        if !rows(&sql, "SELECT seq FROM index_outbox LIMIT 1", vec![])?.is_empty() {
            due = Some(now + if index_failed { 5000 } else { 50 });
        }
        if !outbox_held(&sql)? {
            // A recipient is due when its latest wait is over. Only its head row carries the wait, and the rows behind
            // it look overdue, so taking the earliest of all rows would fire the alarm in a loop while it waits.
            let next = rows(
                &sql,
                "SELECT min(due) AS due FROM (SELECT max(next_attempt_at) AS due FROM outbox GROUP BY recipient_principal_id)",
                vec![],
            )?;
            if let Some(next) = next.first().and_then(|r| r["due"].as_f64()) {
                let soonest = now + if outbox_failed { OUTBOX_RETRY_MS } else { 10 };
                let next = (next as i64).max(soonest);
                due = Some(due.map_or(next, |d| d.min(next)));
            }
        }
        if let Some(next) = migrated
            .then(|| objects::next_scan_expiry(&sql, now))
            .transpose()?
            .flatten()
        {
            due = Some(due.map_or(next, |d| d.min(next)));
        }
        // Like every other due time here, it can only bring the alarm earlier.
        if let Some(next) = (migrated && !outbox_held(&sql)?)
            .then(|| a2a_out::next_due(&sql))
            .transpose()?
            .flatten()
        {
            let next = next.max(now + 10);
            due = Some(due.map_or(next, |d| d.min(next)));
        }
        if let Some(next) = removal::next_due(&sql, now, self.sweep_failures.get())? {
            due = Some(due.map_or(next, |d| d.min(next)));
        }
        let Some(due) = due else {
            return Ok(());
        };
        let current = self.state.storage().get_alarm().await?;
        if current.is_none_or(|at| at > due) {
            self.state
                .storage()
                .set_alarm(std::time::Duration::from_millis((due - now).max(1) as u64))
                .await?;
        }
        Ok(())
    }

    fn init(&self, identity: &Identity, body: &Value) -> R<Value> {
        let name = required(body, "name")?;
        let goal = field(body, "goal")?;
        let context = field(body, "context")?;
        let sql = self.state.storage().sql();
        // Decision 33: only an admin of the organization the room would belong to can create it.
        if !identity.admin_orgs.contains(&identity.org) {
            return Err(ApiError::not_allowed());
        }
        if store::is_initialized(&sql)? {
            return Err(ApiError::not_allowed());
        }
        if name.trim().is_empty() || name.len() > MAX_NAME_BYTES {
            return Err(ApiError::invalid_argument());
        }
        validate_brief(goal.as_deref(), context.as_deref()).map_err(|e| ApiError::from_core(&e))?;
        let id = identity.clone();
        transaction_sync(&self.state, move || {
            let now = now_ms();
            store::migrate(&sql)?;
            // Owner authority lasts as long as the membership it began under.
            let since = id.org_since.get(&id.org).copied().unwrap_or(now);
            exec(&sql, "INSERT INTO workspace (id, name, goal, context, brief_by, owner_org_id, owner_person_id, status, created_at, owner_since) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)", vec![
                id.workspace_id.as_str().into(), name.as_str().into(), opt(&goal), opt(&context), (goal.is_some() || context.is_some()).then(|| id.id.clone()).as_deref().map_or(V::Null, V::from), id.org.as_str().into(), id.id.as_str().into(), now.into(), since.into(),
            ])?;
            let owner = Caller {
                id: id.id.clone(),
                kind: PrincipalKind::Person,
                role: Role::Owner,
                scopes: Scopes::PUBLIC_PARTICIPANT,
            };
            audit(
                &sql,
                &owner,
                "workspace.created",
                &id.workspace_id,
                None,
                Some(json!({ "owner": id.id }).to_string()),
                now,
            )?;
            queue_index(&sql, &id.id, &id.org, Some("owner"), now)?;
            record_event(
                &sql,
                "workspace.created",
                &id.id,
                None,
                &Transition::NONE,
                None,
                now,
            )
        })?;
        Ok(json!({ "id": identity.workspace_id, "owner": identity.id }))
    }

    /// Internal routes come in ahead of the migration in `dispatch`, and the departure rules read every column. Every
    /// migration after a room's creation comes through here, so what a failed one held is applied first (`held`).
    fn migrate_if_needed(&self) -> R<()> {
        self.migrate_and_replay()
    }

    /// What to record if this request is refused: who tried, and a name for the change from a fixed list. Nothing here is
    /// the request's content, and an internal route with no caller or no name has nothing to record.
    fn denial_context(req: &Request) -> Option<(Identity, &'static str)> {
        let identity: Identity = req
            .headers()
            .get(CALLER_HEADER)
            .ok()?
            .as_deref()
            .and_then(|caller| serde_json::from_str(caller).ok())?;
        let path = req.path();
        let name = if path == INTERNAL_ACCEPT_PATH {
            "invitation.accept"
        } else {
            let parts: Vec<&str> = path.trim_start_matches('/').split('/').collect();
            let method = req.method().to_string();
            denied_change_name(&method, parts.get(3..)?)?
        };
        Some((identity, name))
    }

    /// Counts a refusal in memory and returns. Nothing is stored on this path, so a real room and an unknown one do the
    /// same work before answering, and many callers can't slow the room with writes. Only a burst's first refusal touches
    /// storage, to set the alarm, and that's the same in either case. The alarm writes what's held.
    async fn hold_denial(&self, identity: &Identity, action: &'static str, code: &'static str) {
        let now = now_ms();
        {
            let mut held = self.denials_held.borrow_mut();
            let mut key = DenialKey {
                actor: identity.id.clone(),
                kind: identity.kind.clone(),
                action,
                code,
            };
            // New identities can't grow this past its limit.
            if held.len() >= DENIALS_HELD && !held.contains_key(&key) {
                key.actor = OUTSIDER.to_string();
            }
            let entry = held.entry(key).or_insert(HeldDenial {
                count: 0,
                first_at: now,
                last_at: now,
            });
            entry.count += 1;
            entry.last_at = now;
        }
        if !self.denial_alarm_set.get() {
            // Set before the await, so a burst only asks once. A failure below clears it for the next refusal.
            self.denial_alarm_set.set(true);
            let storage = self.state.storage();
            let due = now + (DENIAL_FLUSH_SECS as i64) * 1000;
            let sooner = match storage.get_alarm().await {
                Ok(current) => current.is_none_or(|at| at > due),
                Err(_) => true,
            };
            if sooner {
                if let Err(error) = storage
                    .set_alarm(std::time::Duration::from_secs(DENIAL_FLUSH_SECS))
                    .await
                {
                    self.denial_alarm_set.set(false);
                    console_error!("couldn't schedule the denial record: {:?}", error);
                }
            }
        }
    }

    /// Writes what's held, in one transaction. One row counts one actor's refusals of one kind in a day, and anyone who
    /// was never in the room shares a row. Past the cap, the oldest row of whoever has the most rows goes, so one actor
    /// can't push out another's record. An unknown room stays empty. On failure the counts wait for the next attempt.
    fn flush_denials(&self) -> R<()> {
        self.denial_alarm_set.set(false);
        if self.denials_held.borrow().is_empty() {
            return Ok(());
        }
        let sql = self.state.storage().sql();
        // Before the counts are taken, so an error here keeps them for the next attempt.
        let initialized = store::is_initialized(&sql)?;
        let held = std::mem::take(&mut *self.denials_held.borrow_mut());
        if !initialized {
            return Ok(());
        }
        let keep = held.clone();
        let written = self.migrate_if_needed().and_then(|()| {
            let inner = sql.clone();
            transaction_sync(&self.state, move || write_denials(&inner, &held))?;
            Ok(())
        });
        if written.is_err() {
            let mut current = self.denials_held.borrow_mut();
            for (key, denial) in keep {
                let entry = current.entry(key).or_insert(HeldDenial {
                    count: 0,
                    first_at: denial.first_at,
                    last_at: denial.last_at,
                });
                entry.count += denial.count;
                entry.first_at = entry.first_at.min(denial.first_at);
                entry.last_at = entry.last_at.max(denial.last_at);
            }
        }
        written
    }

    /// Applies a person's departure from an organization, from this room's own state. Repeating it changes nothing.
    fn org_departure(&self, body: &Value) -> R<Value> {
        let sql = self.state.storage().sql();
        if !store::is_initialized(&sql)? {
            return Ok(json!({ "applied": false }));
        }
        // Checked before anything is held, so a held departure always replays.
        departure_fields(body)?;
        if self.migrate_if_needed().is_err() {
            return self.hold(
                held::HELD_DEPARTURE,
                body.clone(),
                json!({ "applied": true }),
            );
        }
        let body = body.clone();
        transaction_sync(&self.state, move || departure_effect(&sql, &body, now_ms()))?;
        Ok(json!({ "applied": true }))
    }

    async fn dispatch(&self, mut req: Request) -> R<Value> {
        if req.path() == "/internal/org-departure" {
            let body: Value = req.json().await?;
            return self.org_departure(&body);
        }
        if req.path() == "/internal/revoke" {
            let body: Value = req.json().await?;
            return self.fence(
                required(&body, "principal")?,
                body["floor"]
                    .as_i64()
                    .ok_or_else(ApiError::invalid_argument)?,
            );
        }
        let raw_identity = req
            .headers()
            .get(CALLER_HEADER)?
            .ok_or_else(|| ApiError::internal("missing caller"))?;
        let identity: Identity = serde_json::from_str(&raw_identity)?;
        let sql = self.state.storage().sql();
        let method = req.method();
        let path = req.path();
        let url = req.url()?;

        if path == INTERNAL_ACCEPT_PATH {
            if cfg!(feature = "failpoints") {
                *self.test_generation.borrow_mut() = req
                    .headers()
                    .get("x-test-join-generation")?
                    .and_then(|v| v.parse().ok());
            }
            let body: Value = serde_json::from_str(&req.text().await?)
                .map_err(|_| ApiError::invalid_argument())?;
            return self.accept_invitation(&identity, &body).await;
        }
        if path == INTERNAL_PREVIEW_PATH {
            let body: Value = serde_json::from_str(&req.text().await?)
                .map_err(|_| ApiError::invalid_argument())?;
            return self.preview_invitation(&identity, &body);
        }
        if path == INTERNAL_INIT_PATH {
            let body: Value = serde_json::from_str(&req.text().await?)
                .map_err(|_| ApiError::invalid_argument())?;
            return self.init(&identity, &body);
        }

        // An unknown room answers from a read, so it stays empty.
        if !store::is_initialized(&sql)? {
            return Err(ApiError::workspace_not_found());
        }
        self.migrate_if_needed()?;
        if path == crate::INTERNAL_UPLOAD_BEGIN || path == crate::INTERNAL_UPLOAD_COMPLETE {
            let body: Value = serde_json::from_str(&req.text().await?)
                .map_err(|_| ApiError::invalid_argument())?;
            return self.upload_step(&path, body);
        }
        if path == crate::INTERNAL_A2A_BEGIN || path == crate::INTERNAL_A2A_FINISH {
            let body: Value = serde_json::from_str(&req.text().await?)
                .map_err(|_| ApiError::invalid_argument())?;
            return self.a2a_step(&path, &identity, body);
        }
        if path == crate::INTERNAL_SCAN_RESULT {
            let body: Value = serde_json::from_str(&req.text().await?)
                .map_err(|_| ApiError::invalid_argument())?;
            return self.scan_verdict(body);
        }
        if path == crate::INTERNAL_DOWNLOAD {
            let body: Value = serde_json::from_str(&req.text().await?)
                .map_err(|_| ApiError::invalid_argument())?;
            return downloads::begin(&sql, &resolve_caller(&sql, &identity)?, &body);
        }
        let path_parts: Vec<&str> = path.trim_start_matches('/').split('/').collect();
        if cfg!(feature = "failpoints") {
            let forced = req
                .headers()
                .get("x-test-join-generation")?
                .and_then(|v| v.parse().ok());
            *self.test_generation.borrow_mut() = forced;
        }
        // An agent's owner may have no role in this room.

        if method == Method::Post {
            if let Some(["members", agent, verb @ ("withdraw" | "owner-consent")]) =
                path_parts.get(3..)
            {
                if let Some(value) = self.agent_owner_action(&identity, agent, verb)? {
                    return Ok(value);
                }
            }
        }
        // Recovery is for someone who may have no role here, and it decides what they're told.
        if method == Method::Post && matches!(path_parts.get(3..), Some(["owner", "recover"])) {
            let key = req.headers().get("idempotency-key")?;
            // A malformed body can't answer differently before the room has decided what to say.
            let body: Value = serde_json::from_str(&req.text().await?).unwrap_or(Value::Null);
            let hash = format!(
                "{:x}",
                Sha256::digest(format!("{method:?} {path} {body}").as_bytes())
            );
            let test_fail =
                cfg!(feature = "failpoints") && req.headers().get("x-test-fail")?.is_some();
            return self.recover_owner(&identity, key, hash, body, test_fail);
        }
        // Read-only oversight of an organization's own agent, for someone who may have no role here.
        if method == Method::Get {
            if let Some(["agents", agent, "tasks", rest @ ..]) = path_parts.get(3..) {
                let Some(view) = oversight_view(&sql, &identity, agent)? else {
                    // An outsider learns nothing, and someone in the room is told no.
                    resolve_caller(&sql, &identity)?;
                    return Err(ApiError::not_allowed());
                };
                return match rest {
                    [] => queries::list_tasks(&sql, &view.caller, &url),
                    [task] => queries::get_task(&sql, &view, task, true),
                    [task, "messages"] => queries::list_messages(&sql, &view, task, &url),
                    _ => Err(ApiError::not_found()),
                };
            }
        }
        if method == Method::Get {
            if let Some(["agents", agent, "files", id]) = path_parts.get(3..) {
                return downloads::read_overseen(&sql, &identity, agent, id);
            }
        }
        // Authority comes before anything about the request, so an outsider gets one answer for every request.
        let who = resolve_caller(&sql, &identity)?;

        let segments: Vec<String> = path
            .trim_start_matches('/')
            .split('/')
            .map(str::to_string)
            .collect();
        let parts: Vec<&str> = segments.iter().map(String::as_str).collect();
        let tail = parts.get(3..).unwrap_or(&[]);

        // An archived room can still lose participants and links, and can come back. Nothing new happens in it, and only
        // recovery, which doesn't come through here, can change its owner. `command`
        // checks this in its transaction, after the replay lookup, so a retry of something committed earlier gets its answer.
        let stops_when_archived = !matches!(
            (&method, tail),
            (Method::Post, ["unarchive"])
                // Decision 93: archiving doesn't shield harmful content from a takedown.
                | (Method::Post, ["files", _, "remove"])
                | (
                    Method::Delete,
                    ["members" | "organizations" | "invitations", _]
                )
        );

        if method == Method::Get {
            return match tail {
                [] => queries::get_workspace(&sql, &who),
                ["invitations"] => queries::list_invitations(&sql, &who.caller, now_ms()),
                ["denials"] => queries::list_denials(&sql, &who.caller, &url),
                ["plan"] => plan::read(&sql, &who.caller, &url),
                #[cfg(feature = "failpoints")]
                ["plan", "costs"] => plan::read_costs(&sql, &who, &url),
                ["roles"] => roles::list_roles(&sql, &who),
                ["outputs"] => outputs::read(&sql, &who),
                ["outputs", output, "versions"] => outputs::read_versions(&sql, &who, output),
                ["card"] => roles::read_card(&sql, &who),
                ["files"] => asset_links::list(&sql, &who, &url),
                ["files", id] => downloads::read_file(&sql, &who, id),
                ["collaboration"] => collaboration::read_map(&sql, &who),
                ["collaboration", "handoffs"] => collaboration::read_edge(&sql, &who, &url),
                #[cfg(feature = "failpoints")]
                ["collaboration", "costs"] => collaboration::read_costs(&sql, &who, &url),
                ["brief"] => queries::get_brief(&sql, &who),
                ["activity"] => queries::list_activity(&sql, &who, &url),
                ["tasks"] => queries::list_tasks(&sql, &who.caller, &url),
                ["tasks", id] => queries::get_task(&sql, &who, id, false),
                ["tasks", id, "messages"] => queries::list_messages(&sql, &who, id, &url),
                ["events"] => queries::list_events(&sql, &who.caller, &url),
                ["audit"] => queries::list_audit(&sql, &who.caller, &url),
                _ => Err(ApiError::not_found()),
            };
        }

        let key = req.headers().get("idempotency-key")?;
        let raw = req.text().await?;
        let body: Value = if raw.trim().is_empty() {
            json!({})
        } else {
            serde_json::from_str(&raw).map_err(|_| ApiError::invalid_argument())?
        };
        // Hashing the parsed body means a retry with reordered keys is still the same request.
        let hash = format!(
            "{:x}",
            Sha256::digest(format!("{method:?} {path} {body}").as_bytes())
        );
        let test_fail = cfg!(feature = "failpoints") && req.headers().get("x-test-fail")?.is_some();
        let target = parts.get(4).map(|s| (*s).to_string()).unwrap_or_default();
        let verb = parts.get(5).map(|s| (*s).to_string()).unwrap_or_default();

        match (method, tail) {
            (Method::Post, ["tasks"]) => self.command(
                &identity,
                key,
                hash,
                stops_when_archived,
                test_fail,
                move |sql, who, now| handle_create_task(sql, &who.caller, &body, now),
            ),
            (Method::Post, ["tasks", _, "messages"]) => self.command(
                &identity,
                key,
                hash,
                stops_when_archived,
                test_fail,
                move |sql, who, now| handle_send_message(sql, who, &target, &body, now),
            ),
            (Method::Post, ["tasks", _, _]) => self.command(
                &identity,
                key,
                hash,
                stops_when_archived,
                test_fail,
                move |sql, who, now| handle_task_command(sql, who, &target, &verb, &body, now),
            ),
            (Method::Post, ["members"]) => {
                // A registered agent's generation comes from its Principal before this room commits the join.
                let mut registered = None;
                let agent = (field(&body, "kind")?.as_deref() == Some("agent"))
                    .then(|| field(&body, "principal_id"))
                    .transpose()?
                    .flatten();
                if let Some(agent) = &agent {
                    ApiError::from_verdict(authorize_workroom(
                        &who.caller,
                        WorkroomAction::ManageAccess,
                    ))?;
                    require_id(agent)?;
                    let org = field(&body, "org_id")?.ok_or_else(ApiError::invalid_argument)?;
                    // Other organizations join by invitation, so this route never touches their agents' Principals.
                    if org != room_owner_org(&sql)? {
                        return Err(ApiError::invitation_required());
                    }
                    let generation = principal::register_room(
                        &self.env,
                        agent,
                        &org,
                        &identity.workspace_id,
                        false,
                    )
                    .await
                    .map_err(|_| ApiError::invalid_argument())?;
                    registered = Some((self.test_generation.borrow().unwrap_or(generation), org));
                }
                let target_member = identity.target_member.clone();
                self.command(
                    &identity,
                    key,
                    hash,
                    stops_when_archived,
                    test_fail,
                    move |sql, who, now| {
                        handle_add_member(sql, &who.caller, &body, registered, target_member, now)
                    },
                )
            }
            (Method::Post, ["members", _, "clear-removal"]) => self.command(
                &identity,
                key,
                hash,
                stops_when_archived,
                test_fail,
                move |sql, who, now| handle_clear_removal(sql, &who.caller, &target, &body, now),
            ),
            (Method::Post, ["invitations"]) => {
                let room = identity.workspace_id.clone();
                self.command(
                    &identity,
                    key,
                    hash,
                    stops_when_archived,
                    test_fail,
                    move |sql, who, now| {
                        handle_create_invitation(sql, &who.caller, &room, &body, now)
                    },
                )
            }
            (Method::Delete, ["invitations", _]) => self.command(
                &identity,
                key,
                hash,
                stops_when_archived,
                test_fail,
                move |sql, who, now| {
                    handle_withdraw_invitation(sql, &who.caller, &target, &body, now)
                },
            ),
            (Method::Post, ["members", _, "role"]) => {
                let target_member = identity.target_member.clone();
                self.command(
                    &identity,
                    key,
                    hash,
                    stops_when_archived,
                    test_fail,
                    move |sql, who, now| {
                        handle_change_role(sql, &who.caller, &target, &body, target_member, now)
                    },
                )
            }
            (Method::Post, ["uploads"]) => {
                let raw = raw_identity.clone();
                self.command(
                    &identity,
                    key,
                    hash,
                    stops_when_archived,
                    test_fail,
                    move |sql, who, now| objects::handle_create(sql, &who.caller, &raw, &body, now),
                )
            }
            (Method::Post, ["files", _, "remove"]) => {
                let checked = target.clone();
                self.command_checked(
                    &identity,
                    key,
                    hash,
                    stops_when_archived,
                    test_fail,
                    move |sql, who| removal::authorize_removal(sql, &who.caller, &checked),
                    move |sql, who, now| removal::handle_remove(sql, &who.caller, &target, now),
                )
            }
            (Method::Post, ["files", file, "links"]) => {
                let file = (*file).to_string();
                self.command(
                    &identity,
                    key,
                    hash,
                    stops_when_archived,
                    test_fail,
                    move |sql, who, now| {
                        asset_links::handle_link(sql, &who.caller, &file, &body, now)
                    },
                )
            }
            (Method::Delete, ["files", file, "links", task]) => {
                let (file, task) = ((*file).to_string(), (*task).to_string());
                self.command(
                    &identity,
                    key,
                    hash,
                    stops_when_archived,
                    test_fail,
                    move |sql, who, now| {
                        asset_links::handle_unlink(sql, &who.caller, &file, &task, now)
                    },
                )
            }
            (Method::Put, ["plan", "start"]) => self.command(
                &identity,
                key,
                hash,
                stops_when_archived,
                test_fail,
                move |sql, who, now| plan::handle_set_start(sql, &who.caller, &body, now),
            ),
            (Method::Put, ["tasks", task, "plan"]) => {
                let task = (*task).to_string();
                self.command(
                    &identity,
                    key,
                    hash,
                    stops_when_archived,
                    test_fail,
                    move |sql, who, now| plan::handle_set(sql, &who.caller, &task, &body, now),
                )
            }
            (Method::Put, ["tasks", task, "expected-output"]) => {
                let task = (*task).to_string();
                let checked = task.clone();
                self.command_checked(
                    &identity,
                    key,
                    hash,
                    stops_when_archived,
                    test_fail,
                    move |sql, who| outputs::authorize_link(sql, &who.caller, &checked).map(|_| ()),
                    move |sql, who, now| {
                        outputs::handle_set_task_output(sql, who, &task, &body, now)
                    },
                )
            }
            (Method::Post, ["outputs"]) => self.command(
                &identity,
                key,
                hash,
                stops_when_archived,
                test_fail,
                move |sql, who, now| outputs::handle_define(sql, &who.caller, &body, now),
            ),
            (Method::Put, ["outputs", output]) => {
                let output = (*output).to_string();
                self.command(
                    &identity,
                    key,
                    hash,
                    stops_when_archived,
                    test_fail,
                    move |sql, who, now| {
                        outputs::handle_update(sql, &who.caller, &output, &body, now)
                    },
                )
            }
            (Method::Delete, ["outputs", output]) => {
                let output = (*output).to_string();
                self.command(
                    &identity,
                    key,
                    hash,
                    stops_when_archived,
                    test_fail,
                    move |sql, who, now| outputs::handle_remove(sql, &who.caller, &output, now),
                )
            }
            (Method::Post, ["collaboration", "planned"]) => self.command(
                &identity,
                key,
                hash,
                stops_when_archived,
                test_fail,
                move |sql, who, now| planned::handle_add(sql, &who.caller, &body, now),
            ),
            (Method::Delete, ["collaboration", "planned", relationship]) => {
                let relationship = (*relationship).to_string();
                self.command(
                    &identity,
                    key,
                    hash,
                    stops_when_archived,
                    test_fail,
                    move |sql, who, now| {
                        planned::handle_remove(sql, &who.caller, &relationship, &body, now)
                    },
                )
            }
            (Method::Post, ["roles"]) => self.command(
                &identity,
                key,
                hash,
                stops_when_archived,
                test_fail,
                move |sql, who, now| roles::handle_create_role(sql, &who.caller, &body, now),
            ),
            (Method::Put, ["roles", _]) => self.command(
                &identity,
                key,
                hash,
                stops_when_archived,
                test_fail,
                move |sql, who, now| {
                    roles::handle_update_role(sql, &who.caller, &target, &body, now)
                },
            ),
            (Method::Delete, ["roles", _]) => self.command(
                &identity,
                key,
                hash,
                stops_when_archived,
                test_fail,
                move |sql, who, now| {
                    roles::handle_close_role(sql, &who.caller, &target, &body, now)
                },
            ),
            (Method::Post, ["roles", _, "invites"]) => self.command(
                &identity,
                key,
                hash,
                stops_when_archived,
                test_fail,
                move |sql, who, now| {
                    roles::handle_invite_to_role(sql, &who.caller, &target, &body, now)
                },
            ),
            (Method::Delete, ["roles", _, "invites", principal]) => {
                let principal = (*principal).to_string();
                self.command(
                    &identity,
                    key,
                    hash,
                    stops_when_archived,
                    test_fail,
                    move |sql, who, now| {
                        roles::handle_withdraw_role_invite(
                            sql,
                            &who.caller,
                            &target,
                            &principal,
                            &body,
                            now,
                        )
                    },
                )
            }
            (Method::Post, ["roles", _, "claim"]) => self.command(
                &identity,
                key,
                hash,
                stops_when_archived,
                test_fail,
                move |sql, who, now| roles::handle_claim_role(sql, &who.caller, &target, now),
            ),
            (Method::Post, ["roles", _, "release"]) => self.command(
                &identity,
                key,
                hash,
                stops_when_archived,
                test_fail,
                move |sql, who, now| roles::handle_release_role(sql, &who.caller, &target, now),
            ),
            (Method::Delete, ["roles", _, "claims", principal]) => {
                let principal = (*principal).to_string();
                self.command(
                    &identity,
                    key,
                    hash,
                    stops_when_archived,
                    test_fail,
                    move |sql, who, now| {
                        roles::handle_end_claim(sql, &who.caller, &target, &principal, &body, now)
                    },
                )
            }
            (Method::Put, ["members", _, "access"]) => self.command(
                &identity,
                key,
                hash,
                stops_when_archived,
                test_fail,
                move |sql, who, now| handle_change_access(sql, &who.caller, &target, &body, now),
            ),
            (Method::Put, ["review-policy"]) => self.command(
                &identity,
                key,
                hash,
                stops_when_archived,
                test_fail,
                move |sql, who, now| handle_set_review_policy(sql, &who.caller, &body, now),
            ),
            (Method::Put, ["brief"]) => self.command(
                &identity,
                key,
                hash,
                stops_when_archived,
                test_fail,
                move |sql, who, now| handle_set_brief(sql, &who.caller, &body, now),
            ),
            (Method::Put, ["name"]) => self.command(
                &identity,
                key,
                hash,
                stops_when_archived,
                test_fail,
                move |sql, who, now| handle_rename_room(sql, &who.caller, &body, now),
            ),
            (Method::Post, ["archive"]) => self.command(
                &identity,
                key,
                hash,
                stops_when_archived,
                test_fail,
                move |sql, who, now| handle_set_room_status(sql, &who.caller, ARCHIVED, &body, now),
            ),
            (Method::Post, ["unarchive"]) => self.command(
                &identity,
                key,
                hash,
                stops_when_archived,
                test_fail,
                move |sql, who, now| {
                    handle_set_room_status(sql, &who.caller, ACTIVE_ROOM, &body, now)
                },
            ),
            (Method::Delete, ["organizations", _]) => self.command(
                &identity,
                key,
                hash,
                stops_when_archived,
                test_fail,
                move |sql, who, now| {
                    handle_revoke_organization(sql, &who.caller, &target, &body, now)
                },
            ),
            (Method::Post, ["owner", "transfer"]) => {
                let target_member = identity.target_member.clone();
                self.command(
                    &identity,
                    key,
                    hash,
                    stops_when_archived,
                    test_fail,
                    move |sql, who, now| {
                        handle_transfer_owner(sql, &who.caller, &body, target_member, now)
                    },
                )
            }
            (Method::Delete, ["members", _]) => self.command(
                &identity,
                key,
                hash,
                stops_when_archived,
                test_fail,
                move |sql, who, now| handle_revoke_member(sql, &who.caller, &target, &body, now),
            ),
            _ => Err(ApiError::not_found()),
        }
    }
}

impl DurableObject for Workspace {
    fn new(state: State, env: Env) -> Self {
        Self {
            state,
            env,
            test_generation: RefCell::new(None),
            denials_held: RefCell::new(HeldDenials::new()),
            denial_alarm_set: std::cell::Cell::new(false),
            sweep_failures: std::cell::Cell::new(0),
            held_clear: std::cell::Cell::new(false),
        }
    }

    async fn fetch(&self, req: Request) -> Result<Response> {
        let is_write = req.method() != Method::Get;
        // A request that migrates the room arms it afterwards, a read included, so scans left over from before the migration still
        // end on time.
        let migrates = {
            let sql = self.state.storage().sql();
            store::is_initialized(&sql).unwrap_or(false)
                && store::needs_migration(&sql).unwrap_or(false)
        };
        let denial = if is_write {
            Self::denial_context(&req)
        } else {
            None
        };
        let response = match self.dispatch(req).await {
            Ok(value) => Response::from_json(&value),
            Err(error) => {
                if let (Some((identity, action)), Some(code)) = (&denial, error.code()) {
                    if is_authority_refusal(action, code) {
                        self.hold_denial(identity, action, code).await;
                    }
                }
                error.into_response()
            }
        };
        if is_write || migrates {
            // The command has already committed, so a scheduling problem can't change its answer. The next write retries.
            if let Err(error) = self.arm(false, false).await {
                console_error!("couldn't schedule delivery: {:?}", error);
            }
        }
        response
    }

    async fn alarm(&self) -> Result<Response> {
        let denials = self.flush_denials();
        if let Err(error) = &denials {
            console_error!("couldn't record denials: {:?}", error.code());
            if let Err(error) = self
                .state
                .storage()
                .set_alarm(std::time::Duration::from_secs(DENIAL_FLUSH_SECS))
                .await
            {
                console_error!("couldn't schedule the denial record: {:?}", error);
            }
        }
        let index = self.drain_index().await;
        if let Err(error) = &index {
            console_error!("index projection failed: {:?}", error);
        }
        // A stuck scan fails closed here, and this failing holds up nothing else.
        if let Err(error) = self.expire_scans() {
            console_error!("couldn't end overdue scans: {:?}", error.code());
        }
        self.sweep_files().await;
        // One failing doesn't hold up the other.
        let outbox = self.drain_outbox().await;
        // A2A offers go on their own queue. An attempt that couldn't be queued waits with its own backoff.
        if let Err(error) = self.drain_a2a().await {
            console_error!("a2a outbox drain failed: {:?}", error.code());
        }
        if let Err(error) = &outbox {
            console_error!("outbox drain failed: {:?}", error);
        }
        if let Err(error) = self.arm(index.is_err(), outbox.is_err()).await {
            console_error!("couldn't schedule delivery: {:?}", error);
            self.state
                .storage()
                .set_alarm(std::time::Duration::from_secs(5))
                .await?;
        }
        Response::ok("ok")
    }
}

/// A disconnect's effect in one room: raise the floor, and remove the agent if it joined below it. The caller holds the
/// transaction, so a held fence replays through the same code.
fn fence_effect(sql: &SqlStorage, principal: &str, floor: i64, now: i64) -> R<()> {
    let prior = rows(
        sql,
        "SELECT min_generation FROM principal_fence WHERE principal_id = ?",
        vec![principal.into()],
    )?;
    let raises = prior.first().map_or(0, |f| int(&f["min_generation"])) < floor;
    exec(sql, "INSERT INTO principal_fence (principal_id, min_generation) VALUES (?, ?)
      ON CONFLICT (principal_id) DO UPDATE SET min_generation = max(min_generation, excluded.min_generation)", vec![principal.into(), floor.into()])?;
    // A new disconnect cancels earlier consent to return. A delayed retry of an old one doesn't.
    if raises {
        exec(sql, "UPDATE member SET owner_consented_at = NULL WHERE principal_id = ? AND revoked_at IS NOT NULL", vec![principal.into()])?;
    }
    let found = rows(sql, "SELECT join_generation FROM member WHERE principal_id = ? AND revoked_at IS NULL AND kind = 'agent'", vec![principal.into()])?;
    if found
        .first()
        .is_some_and(|m| int(&m["join_generation"]) < floor)
    {
        let system = Caller {
            id: "system".to_string(),
            kind: PrincipalKind::Agent,
            role: Role::None,
            scopes: Scopes::PUBLIC_PARTICIPANT,
        };
        remove_member(sql, &system, "system", principal, "global_disconnect", now)?;
    }
    Ok(())
}

fn departure_fields(body: &Value) -> R<(String, String, String, i64)> {
    let left_at = body["left_at"]
        .as_i64()
        .ok_or_else(ApiError::invalid_argument)?;
    Ok((
        required(body, "person")?,
        required(body, "org")?,
        required(body, "actor")?,
        left_at,
    ))
}

/// An organization departure's effect in one room. The caller holds the transaction, so a held departure replays through the
/// same code.
fn departure_effect(sql: &SqlStorage, body: &Value, now: i64) -> R<()> {
    let (person, org, actor_id, left_at) = departure_fields(body)?;
    let actor = Caller {
        id: actor_id.clone(),
        kind: PrincipalKind::Person,
        role: Role::None,
        scopes: Scopes::PUBLIC_PARTICIPANT,
    };
    let found = rows(sql, "SELECT org_id, added_at FROM member WHERE principal_id = ? AND kind = 'person' AND revoked_at IS NULL", vec![person.as_str().into()])?;
    if let Some(member) = found.first() {
        let held = text(&member["org_id"]).unwrap_or_default();
        if org_departure_ends(&held, &org, int(&member["added_at"]), left_at) {
            remove_member(sql, &actor, "person", &person, "org_departure", now)?;
        }
    }
    let room_org = room_owner_org(sql)?;
    let invitations = rows(
        sql,
        "SELECT id, created_at FROM invitation WHERE created_by = ? AND status = 'pending'",
        vec![person.as_str().into()],
    )?;
    for invitation in &invitations {
        if org_departure_ends(&room_org, &org, int(&invitation["created_at"]), left_at) {
            let id = text(&invitation["id"]).unwrap_or_default();
            exec(
                sql,
                "UPDATE invitation SET status = 'withdrawn' WHERE id = ?",
                vec![id.as_str().into()],
            )?;
            let reason = json!({ "reason": "org_departure" }).to_string();
            audit(
                sql,
                &actor,
                "invitation.withdrawn",
                &id,
                None,
                Some(reason),
                now,
            )?;
        }
    }
    // The room keeps its owner until recovery names another. They stop being a participant, so their tasks follow the
    // departure table and nothing more reaches their inbox. Each departure applies once, and one from before they
    // became owner under their current membership doesn't count.
    if is_owner(sql, &person)? && room_org == org {
        let since = rows(sql, "SELECT owner_since FROM workspace", vec![])?;
        let rejoined = since
            .first()
            .and_then(|room| room["owner_since"].as_i64())
            .is_some_and(|since| since > left_at);
        let note = json!({ "org_id": org, "left_at": left_at }).to_string();
        let noted = rows(
            sql,
            "SELECT id FROM audit_event WHERE action = 'owner.left_organization' AND new_json = ?",
            vec![note.as_str().into()],
        )?;
        if !rejoined && noted.is_empty() {
            exec(
                sql,
                "UPDATE workspace SET owner_left_at = MAX(COALESCE(owner_left_at, 0), ?)",
                vec![left_at.into()],
            )?;
            apply_departure_rules(sql, &actor, &person, now)?;
            objects::drop_uploads_of(sql, &actor.id, "person", &person, now)?;
            queue_index(sql, &person, &org, Some("owner"), now)?;
            audit(
                sql,
                &actor,
                "owner.left_organization",
                &person,
                None,
                Some(note),
                now,
            )?;
        }
    }
    Ok(())
}
