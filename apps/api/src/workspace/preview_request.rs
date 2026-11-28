//! Asking for a preview of a task's merged commit (`requestPreview`, `POST /v1/workspaces/{ws}/tasks/{t}/preview`; M8
//! step 6; the preview plan, `docs/m8-preview-plan.md`, 3.2, 3.4 and 9.1; decisions 250, 251, 253 and 257).
//!
//! **One command creates or replaces** (the plan's 3.2). With no slot it makes one: a `pvw_` ID and a preview label,
//! drawn from the same never-reused space as production's labels (`app_label`'s primary key holds both kinds), of kind
//! `preview` and never `current`, and the slot's applier row for its default host. With a slot it records a new preview
//! release, and the slot goes on serving the old one until the new one's marker comes back (`release_marker`).
//!
//! **What a request writes,** in one transaction with its idempotency record: the release, **queued at once**, since the
//! person asking is one who may approve (decision 253: owner or admin, as a person, no grant), with `approved_by` that
//! person; its environment, `preview` (step 59); who asked (`release_requester`); the audit record and the event
//! `preview.requested`, told to the room's owner and its admins who are people. **Nothing is read from a repository,
//! uploaded or served by it:** the release job takes it up as any queued release (`release_driver`).
//!
//! **Who and where** is `podster_policy::preview::authorize_preview_change` (`Request`), in the contract's order: who on
//! the room's rows; then `previews_off`; then everything release needs **but a public room** (decision 251); then the
//! asker still in the organization their place here is held in. **What** is production's commit rule exactly
//! (`podster_core::release::releasable_commit`: decision 250 changes nothing about what is releasable), the room's
//! reviewer rule as it is now, then core's `preview_request`: no replacement in flight (`preview_in_flight`) and one of
//! the room's 20 asks a rolling day, shared with releases (`preview_limit`).
//!
//! **What is read outside the room, and when,** before the transaction, as every release command reads it: the release
//! path's gate, the deployment's two settings, the organization's delegation and release switch (`on_reads`), and the
//! asker's own `Principal`. **A fact that was read and fails refuses; one that couldn't be read, with nothing read
//! failing, is `standing_unknown` (503), which writes nothing.** [`standing`] is also what a replay of a stored answer is
//! checked against, so a retry from someone who has since lost their role, or into a room where previews may no longer
//! happen, is refused by the code that holds now.
//!
//! The route exists only while `RELEASES` is on, as every M6 route; otherwise the room answers it as an unknown route.
//! Logs carry IDs and codes only.
use super::release_config::{room_assuming, OnReads};
use super::release_recheck::{release_now, settled, standing_unknown, Asked};
use super::*;
use podster_core::preview::{
    preview_request, DeploymentPreviews, PreviewRequestPlan, PreviewRequestRefusal, SlotStatus,
    SLOT_ID_PREFIX,
};
use podster_core::release::{
    label_acceptable, label_from_random, releasable_commit, CommitRecord, CommitRefusal,
    ReleaseState, ENVIRONMENT, RELEASE_WINDOW_MS,
};
use podster_policy::preview::{authorize_preview_change, PreviewChange};

/// How many labels are made ready for one request, as for a release's (`release_request`).
const LABEL_TRIES: usize = 4;
/// The shortest word of the room's name or handle a label must not hold.
const AVOIDED_WORD: usize = 4;

/// What was read outside the room before the transaction. Never taken from a request's body.
pub(super) struct PreviewReads {
    room: OnReads,
    previews: DeploymentPreviews,
    /// The asker's own standing: still in the organization their place here is held in.
    asker: Asked,
    /// Randomness for a new slot's label and ID, used only if the room has no slot.
    labels: Vec<[u8; 16]>,
    slot_id: String,
    /// The content domain, which names the slot's default host. With none configured no preview can be made.
    domain: Option<String>,
}

/// Who may ask at all, by the room's rows alone, before anything outside the room is read: the room's owner or an
/// admin, as a person. Agents and everyone else are refused here, whatever previews or release say.
pub(super) fn may_ask(who: &Participant) -> R<()> {
    authorize_preview_change(
        &who.caller,
        true,
        DeploymentPreviews::On,
        &podster_policy::release::ReleaseRoom::OPEN,
        PreviewChange::Request,
    )
    .map_err(super::preview::denied)
}

/// Whether the caller may ask for a preview now, on the room's rows and what was read outside, in the room's
/// transaction. **An outside fact that couldn't be read is taken as holding and remembered,** so a fact read and failing
/// refuses with its own code; only when nothing read fails does an unread one answer `standing_unknown`. Nothing here
/// names a task, so who is asking is settled before anything is said about one. Run on every attempt, a replay too.
pub(super) fn standing(sql: &SqlStorage, who: &Participant, reads: &PreviewReads) -> R<()> {
    let (room, room_unknown) = room_assuming(sql, &reads.room)?;
    let holds = settled(sql, &reads.asker, Some(&who.caller.id), true)?;
    authorize_preview_change(
        &who.caller,
        holds.unwrap_or(true),
        reads.previews,
        &room,
        PreviewChange::Request,
    )
    .map_err(super::preview::denied)?;
    if room_unknown || holds.is_none() {
        return Err(standing_unknown());
    }
    Ok(())
}

/// The body: `{ commit_sha }` and nothing else.
fn commit_named(body: &Value) -> R<String> {
    let fields = body.as_object().ok_or_else(ApiError::invalid_argument)?;
    if fields.keys().any(|key| key != "commit_sha") {
        return Err(ApiError::invalid_argument());
    }
    body["commit_sha"]
        .as_str()
        .filter(|sha| {
            sha.len() == 40 && sha.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        })
        .map(str::to_owned)
        .ok_or_else(ApiError::invalid_argument)
}

/// A refusal of core's, as the API answers it: a commit or the reviewer rule, 409; `preview_in_flight`, 409;
/// `preview_limit`, 429.
fn refused_commit(refusal: CommitRefusal) -> ApiError {
    let code = refusal.code();
    // error-codes: commit_not_releasable, invalid_argument
    ApiError::api(if code == "invalid_argument" { 400 } else { 409 }, code)
}

fn refused(refusal: PreviewRequestRefusal) -> ApiError {
    match refusal {
        PreviewRequestRefusal::InFlight => {
            // error-codes: preview_in_flight
            ApiError::api(409, "preview_in_flight")
        }
        PreviewRequestRefusal::Limit => {
            // error-codes: preview_limit
            ApiError::api(429, "preview_limit")
        }
    }
}

/// A new preview label of the room's, from the randomness read before the transaction: the same space and the same
/// rule as a production label (`podster_core::release::label_from_random`), never one the room ever had, of either kind.
fn new_label(sql: &SqlStorage, candidates: &[[u8; 16]], now: i64) -> R<String> {
    let room = rows(sql, "SELECT name, public_handle FROM workspace", vec![])?;
    let room = room.first();
    let words: Vec<String> = ["name", "public_handle"]
        .into_iter()
        .filter_map(|column| room.and_then(|row| text(&row[column])))
        .flat_map(|value| {
            value
                .split(|c: char| !c.is_ascii_alphanumeric())
                .filter(|word| word.len() >= AVOIDED_WORD)
                .map(str::to_ascii_lowercase)
                .collect::<Vec<_>>()
        })
        .collect();
    let avoid: Vec<&str> = words.iter().map(String::as_str).collect();
    for random in candidates {
        let label = label_from_random(*random);
        let used = !rows(
            sql,
            "SELECT 1 AS used FROM app_label WHERE label = ?",
            vec![label.as_str().into()],
        )?
        .is_empty();
        if label_acceptable(&label, &avoid) && !used {
            exec(
                sql,
                "INSERT INTO app_label (label, kind, created_at) VALUES (?, 'preview', ?)",
                vec![label.as_str().into(), now.into()],
            )?;
            return Ok(label);
        }
    }
    Err(ApiError::internal("no acceptable preview label"))
}

/// Makes the room's slot, its preview label and its default host's applier row, in the caller's transaction.
fn make_slot(sql: &SqlStorage, reads: &PreviewReads, domain: &str, now: i64) -> R<String> {
    let label = new_label(sql, &reads.labels, now)?;
    exec(
        sql,
        "INSERT INTO preview_slot (id, label, current, created_at, updated_at) VALUES (?, ?, 1, ?, ?)",
        vec![
            reads.slot_id.as_str().into(),
            label.as_str().into(),
            now.into(),
            now.into(),
        ],
    )?;
    exec(
        sql,
        "INSERT INTO preview_apply (host, slot_id, updated_at) VALUES (?, ?, ?)",
        vec![
            format!("{label}.{domain}").into(),
            reads.slot_id.as_str().into(),
            now.into(),
        ],
    )?;
    Ok(label)
}

/// `POST tasks/{t}/preview`, in the room's transaction, after [`Workspace::preview_reads`]. **Run only as the handler of
/// `command_checked` whose recheck is [`standing`],** so who is asking, and where, is settled first on every attempt.
pub(super) fn handle(
    sql: &SqlStorage,
    who: &Participant,
    task_id: &str,
    body: &Value,
    reads: &PreviewReads,
) -> R<Value> {
    let now = release_now(sql);
    release_commit::end_stale(sql, now)?;
    let commit_sha = commit_named(body)?;
    let task = load_task(sql, task_id)?
        .filter(|task| can_see_task(&who.caller, task))
        .ok_or_else(ApiError::task_not_found)?;
    // What, on the room's own rows: production's rule for what is releasable, exactly.
    let change = rows(
        sql,
        "SELECT c.merge_sha, c.provider_repo_id, c.merge_state, c.merge_called_at, c.merge_finished_at, c.reviewer_id, t.status
           FROM task_change c JOIN task t ON t.id = c.task_id WHERE c.task_id = ?",
        vec![task.id.as_str().into()],
    )?;
    let change = change.first();
    let merged = change.and_then(|row| {
        let succeeded = row["merge_state"].as_str() == Some("succeeded");
        Some((
            text(&row["merge_sha"])?,
            int(&row["provider_repo_id"]),
            succeeded && !row["merge_called_at"].is_null(),
            succeeded && !row["merge_finished_at"].is_null(),
            row["status"].as_str() == Some("completed"),
        ))
    });
    let record = merged.as_ref().map(|m| CommitRecord {
        sha: &m.0,
        provider_repo_id: m.1,
        merged_by_podster: m.2,
        confirmed_on_default_branch: m.3,
        task_completed: m.4,
    });
    let link_repo_id = rows(sql, "SELECT provider_repo_id FROM repo_link", vec![])?
        .first()
        .map_or(0, |link| int(&link["provider_repo_id"]));
    // The environment named here is the commit rule's own, which is production's: a preview is of reviewed, merged
    // commits only (decision 250), so nothing about what is releasable is the preview's to loosen.
    releasable_commit(&commit_sha, ENVIRONMENT, record.as_ref(), link_repo_id)
        .map_err(refused_commit)?;
    let reviewer_rule_holds = !store::requires_person_review(sql)?
        || change
            .and_then(|row| row["reviewer_id"].as_str())
            .is_some_and(|reviewer| parse_kind_of(reviewer) == PrincipalKind::Person);
    if !reviewer_rule_holds {
        // error-codes: reviewer_rule_changed
        return Err(ApiError::api(409, "reviewer_rule_changed"));
    }
    let status = super::preview::slot_status(sql)?;
    let attempts: Vec<ReleaseState> = rows(
        sql,
        &format!(
            "SELECT state FROM release WHERE {}",
            super::preview::IS_PREVIEW
        ),
        vec![],
    )?
    .iter()
    .filter_map(|row| row["state"].as_str())
    .filter_map(|name| ReleaseState::ALL.into_iter().find(|s| s.name() == name))
    .filter(|state| !state.is_final())
    .collect();
    // Every release and preview the room asked for in the rolling day: previews share the room's 20 (decision 257).
    let asked_at: Vec<i64> = rows(
        sql,
        "SELECT requested_at FROM release WHERE requested_at >= ?",
        vec![podster_core::release::window_start(now, RELEASE_WINDOW_MS).into()],
    )?
    .iter()
    .map(|row| int(&row["requested_at"]))
    .collect();
    let plan = preview_request(status, &attempts, &asked_at, now).map_err(refused)?;
    let label = match plan {
        PreviewRequestPlan::Create => {
            let Some(domain) = reads.domain.as_deref() else {
                console_error!(
                    "preview: a request found no content domain: room={} code=content_domain_unset",
                    super::release_driver::room_id(sql)
                );
                return Err(crate::releases::release_not_available());
            };
            make_slot(sql, reads, domain, now)?
        }
        PreviewRequestPlan::Replace => super::preview::current(sql)?
            .map(|stored| stored.slot.label().to_owned())
            .ok_or_else(|| ApiError::internal("a preview to replace with no slot"))?,
    };
    let config = rows(
        sql,
        "SELECT version, release_epoch FROM release_config",
        vec![],
    )?;
    let config = config
        .first()
        .ok_or_else(|| ApiError::internal("release is on with no configuration"))?;
    let id = format!("rel_{}", uuid::Uuid::new_v4().simple());
    let caller = &who.caller;
    // Queued at once, its approver the person asking, who may approve (decision 253). Its epoch is the room's release
    // epoch, so every production unpublish ends it as it ends a release on its way; the slot's own serve epoch is what
    // its commit is held to (`preview_commit`).
    exec(
        sql,
        "INSERT INTO release (id, commit_sha, task_id, state, label, config_version, release_epoch, requested_by, requested_at,
           approved_by, approved_at, updated_at) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?)",
        vec![
            id.as_str().into(),
            commit_sha.as_str().into(),
            task.id.as_str().into(),
            label.as_str().into(),
            int(&config["version"]).into(),
            int(&config["release_epoch"]).into(),
            caller.id.as_str().into(),
            now.into(),
            caller.id.as_str().into(),
            now.into(),
            now.into(),
        ],
    )?;
    exec(
        sql,
        "INSERT INTO release_environment (release_id, environment) VALUES (?, 'preview')",
        vec![id.as_str().into()],
    )?;
    exec(
        sql,
        "INSERT INTO release_requester (release_id, requester_person) VALUES (?, ?)",
        vec![id.as_str().into(), caller.id.as_str().into()],
    )?;
    let created = plan == PreviewRequestPlan::Create;
    audit(
        sql,
        caller,
        "preview.requested",
        &id,
        None,
        Some(json!({ "state": "queued", "task_id": task.id, "commit_sha": commit_sha, "created": created }).to_string()),
        now,
    )?;
    store::record_event_about(
        sql,
        "preview.requested",
        &caller.id,
        Some(&id),
        None,
        &Transition::NONE,
        super::preview::told(sql, &caller.id)?,
        now,
    )?;
    if status == SlotStatus::None {
        console_log!(
            "preview: a slot was made: room={} release={}",
            super::release_driver::room_id(sql),
            id
        );
    }
    super::preview::view_release(sql, &id)
}

impl Workspace {
    /// Everything `requestPreview` reads outside the room, before its transaction: the release path's gate first, as
    /// every release command passes it; the deployment's settings and the organization's facts; the asker's own record;
    /// and randomness for a slot the room may not need.
    pub(super) async fn preview_reads(&self, caller_id: &str) -> R<PreviewReads> {
        self.release_path_open().await?;
        let room = self.on_reads().await?;
        let previews = crate::previews::setting(&self.env).await;
        let asker = self.still_holds(Some(caller_id), true).await?;
        let mut labels = Vec::with_capacity(LABEL_TRIES);
        while labels.len() < LABEL_TRIES {
            let random = super::hostname::random_32()?;
            let (first, second) = random.split_at(16);
            for half in [first, second] {
                let mut bytes = [0u8; 16];
                bytes.copy_from_slice(half);
                labels.push(bytes);
            }
        }
        let drawn = super::hostname::random_32()?;
        let slot_id = format!(
            "{SLOT_ID_PREFIX}{}",
            drawn
                .iter()
                .take(16)
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        );
        Ok(PreviewReads {
            room,
            previews,
            asker,
            labels,
            slot_id,
            domain: crate::content_provider::content_domain(&self.env),
        })
    }
}
