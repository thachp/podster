//! A room's visibility (M4 step 5): the owner's preview, going public and private, and the topic. The rules are
//! `podster_policy::public` (ADR 0008, decisions 146 to 155 and 159). Nothing here is reachable without signing in: the
//! public read comes in step 7.
//!
//! **`PUBLIC_ROOMS`** is off unless the Worker's variable says `true`. It's set nowhere in `wrangler.jsonc`, so it's off in
//! every environment until the owner switches it on. While it's off, publishing is refused and going private still works.
use super::*;
use podster_policy::public::{
    content_hash, decide_set_visibility, parse_topic, public_content, public_handle_from, utc_day,
    MemberRow, OpeningRow, OutputRow, PublishRefusal, RoomRow, RoomState, Topic, Visibility,
    VisibilityChange, VisibilityRefusal, VisibilityRequest, Workflow,
};

pub(super) const PUBLIC_ROOMS_VAR: &str = "PUBLIC_ROOMS";

/// Whether public rooms are switched on. Test builds can also switch them on for one request.
pub(crate) fn public_rooms_enabled(env: &Env, req: &Request) -> R<bool> {
    let set = env
        .var(PUBLIC_ROOMS_VAR)
        .is_ok_and(|value| value.to_string() == "true");
    #[cfg(feature = "failpoints")]
    if req.headers().get("x-test-public-rooms")?.as_deref() == Some("on") {
        return Ok(true);
    }
    #[cfg(not(feature = "failpoints"))]
    let _ = req;
    Ok(set)
}

fn visibility_of(row: &Value) -> Visibility {
    if row["visibility"].as_str() == Some("public") {
        Visibility::Public
    } else {
        Visibility::Private
    }
}

/// The room's rows, as `podster_policy::public` reads them. They carry more than is ever public; the policy picks.
pub(super) fn room_state(sql: &SqlStorage) -> R<RoomState> {
    let room = rows(sql, "SELECT * FROM workspace", vec![])?
        .into_iter()
        .next()
        .ok_or_else(ApiError::workspace_not_found)?;
    let openings = rows(sql, "SELECT * FROM work_role", vec![])?
        .iter()
        .map(|row| {
            let id = text(&row["id"]).unwrap_or_default();
            let holders = rows(
                sql,
                "SELECT principal_id FROM role_claim WHERE role_id = ? AND status = 'active'",
                vec![id.as_str().into()],
            )?
            .iter()
            .filter_map(|claim| text(&claim["principal_id"]))
            .collect();
            Ok(OpeningRow {
                id,
                title: text(&row["title"]).unwrap_or_default(),
                responsibilities: text(&row["responsibilities"]).unwrap_or_default(),
                capacity: u32::try_from(int(&row["capacity"])).unwrap_or(0),
                // An unknown preset can't be claimed publicly, so it fails closed as the narrowest.
                preset: row["preset"]
                    .as_str()
                    .and_then(Preset::from_name)
                    .unwrap_or(Preset::PublicParticipant),
                is_lead: int(&row["is_lead"]) != 0,
                publicly_claimable: int(&row["publicly_claimable"]) != 0,
                created_by: text(&row["created_by"]).unwrap_or_default(),
                created_at: int(&row["created_at"]),
                version: u64::try_from(int(&row["version"])).unwrap_or(0),
                closed_at: row["closed_at"].as_i64(),
                active_holders: holders,
            })
        })
        .collect::<R<Vec<_>>>()?;
    let outputs = rows(sql, "SELECT * FROM expected_output", vec![])?
        .iter()
        .map(|row| OutputRow {
            id: text(&row["id"]).unwrap_or_default(),
            title: text(&row["title"]).unwrap_or_default(),
            description: text(&row["description"]),
            // The same rule as the outputs read and the card: Ready once it has an approved version.
            ready: row["current_task_id"].as_str().is_some(),
            created_by: text(&row["created_by"]).unwrap_or_default(),
            removed_at: row["removed_at"].as_i64(),
            current_task_id: text(&row["current_task_id"]),
            current_submission_no: row["current_submission_no"]
                .as_i64()
                .and_then(|n| u32::try_from(n).ok()),
        })
        .collect();
    let mut members: Vec<MemberRow> = rows(
        sql,
        "SELECT principal_id, kind, org_id, revoked_at FROM member WHERE revoked_at IS NULL",
        vec![],
    )?
    .iter()
    .map(|row| MemberRow {
        principal_id: text(&row["principal_id"]).unwrap_or_default(),
        kind: if row["kind"].as_str() == Some("person") {
            PrincipalKind::Person
        } else {
            PrincipalKind::Agent
        },
        org_id: text(&row["org_id"]).unwrap_or_default(),
        revoked_at: row["revoked_at"].as_i64(),
    })
    .collect();
    // The owner is a column, not a member row, and counts as a participant until they leave.
    let owner = text(&room["owner_person_id"]).unwrap_or_default();
    if !members.iter().any(|m| m.principal_id == owner) {
        members.push(MemberRow {
            principal_id: owner.clone(),
            kind: PrincipalKind::Person,
            org_id: text(&room["owner_org_id"]).unwrap_or_default(),
            revoked_at: room["owner_left_at"].as_i64(),
        });
    }
    Ok(RoomState {
        room: RoomRow {
            workspace_id: text(&room["id"]).unwrap_or_default(),
            name: text(&room["name"]).unwrap_or_default(),
            goal: text(&room["goal"]),
            context: text(&room["context"]),
            brief_by: text(&room["brief_by"]),
            owner_org_id: text(&room["owner_org_id"]).unwrap_or_default(),
            owner_person_id: owner,
            policy_version: u64::try_from(int(&room["policy_version"])).unwrap_or(0),
            created_at: int(&room["created_at"]),
            archived: room["status"].as_str() == Some("archived"),
            // Engineering rooms come with managed repositories (M5). Until then every room is General.
            workflow: Workflow::General,
            topic: room["topic"].as_str().and_then(Topic::from_name),
            require_person_review: int(&room["require_person_review"]) != 0,
            visibility: visibility_of(&room),
            public_handle: text(&room["public_handle"]),
            // The column is milliseconds, as every time in the room is; the policy reads whole seconds.
            published_at: room["published_at"].as_i64().map(|ms| ms.div_euclid(1000)),
            suspended: !room["suspended_at"].is_null(),
            public_claims_paused: int(&room["public_claims_paused"]) != 0,
        },
        openings,
        outputs,
        members,
    })
}

/// The owner's and admins' view of the room's visibility: where it stands, and the exact content that would be public,
/// with the hash a publish names. Anyone else in the room gets `not_allowed`.
pub(super) fn read(sql: &SqlStorage, who: &Participant, public_rooms_enabled: bool) -> R<Value> {
    ApiError::from_verdict(authorize_workroom(&who.caller, WorkroomAction::ManageRoom))?;
    let state = room_state(sql)?;
    let content = public_content(&state);
    let preview: Value =
        serde_json::from_str(&content.to_json()).map_err(|_| ApiError::internal("preview json"))?;
    let room = &state.room;
    Ok(json!({
        "visibility": if room.visibility == Visibility::Public { "public" } else { "private" },
        "public_handle": room.public_handle,
        // Milliseconds, as every time the API answers with.
        "published_at": rows(sql, "SELECT published_at FROM workspace", vec![])?
            .first()
            .map_or(Value::Null, |r| r["published_at"].clone()),
        // The UTC day the public page shows, from the policy's seconds.
        "published_on": room.published_at.map(utc_day),
        "topic": room.topic.map(Topic::name),
        "public_claims_paused": room.public_claims_paused,
        // "Suspended by Podster", with the operator's reason code, until an operator lifts it.
        "suspension": super::moderation::suspension(sql)?,
        "public_rooms_enabled": public_rooms_enabled,
        "preview": preview,
        "view_hash": content_hash(&content),
    }))
}

fn parse_request(body: &Value) -> R<VisibilityRequest> {
    let fields = body.as_object().ok_or_else(ApiError::invalid_argument)?;
    match body["visibility"].as_str() {
        Some("public") => {
            if fields.keys().any(|k| k != "visibility" && k != "view_hash") {
                return Err(ApiError::invalid_argument());
            }
            let view_hash = body["view_hash"]
                .as_str()
                .filter(|h| h.len() == 64 && h.bytes().all(|b| b.is_ascii_hexdigit()))
                .ok_or_else(ApiError::invalid_argument)?;
            Ok(VisibilityRequest::Publish {
                view_hash: view_hash.to_ascii_lowercase(),
            })
        }
        Some("private") => {
            if fields
                .keys()
                .any(|k| k != "visibility" && k != "end_public_claims")
            {
                return Err(ApiError::invalid_argument());
            }
            let end_public_claims = match body.get("end_public_claims") {
                None => false,
                Some(value) => value.as_bool().ok_or_else(ApiError::invalid_argument)?,
            };
            Ok(VisibilityRequest::Unpublish { end_public_claims })
        }
        _ => Err(ApiError::invalid_argument()),
    }
}

/// 16 bytes from two v4 UUIDs, 244 random bits, through SHA-256, for a handle's 128 bits.
fn handle_bytes() -> [u8; 16] {
    let digest = Sha256::digest(
        format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        )
        .as_bytes(),
    );
    let mut bytes = [0u8; 16];
    for (out, b) in bytes.iter_mut().zip(digest.iter()) {
        *out = *b;
    }
    bytes
}

fn refusal(refusal: VisibilityRefusal) -> ApiError {
    match refusal {
        VisibilityRefusal::Denied(verdict) => match ApiError::from_verdict(verdict) {
            Err(error) => error,
            Ok(()) => ApiError::not_allowed(),
        },
        // One mapping for the code: the policy's. Only the status is chosen here.
        VisibilityRefusal::Publish(refusal) => match refusal {
            PublishRefusal::StalePreview => {
                ApiError::from_core(&podster_core::CoreError::VersionConflict)
            }
            PublishRefusal::Archived => ApiError::workspace_archived(),
            PublishRefusal::Disabled | PublishRefusal::Suspended => {
                ApiError::api(403, refusal.code())
            }
            PublishRefusal::PersonReviewOff => ApiError::api(409, refusal.code()),
        },
    }
}

/// `set_visibility`: go public naming the previewed content's hash, or go private. Authority comes first. A change commits
/// the room's columns, an audit row and an event to everyone in the room together, and answers as `read` does.
pub(super) fn handle_set_visibility(
    sql: &SqlStorage,
    who: &Participant,
    body: &Value,
    public_rooms_enabled: bool,
    now: i64,
) -> R<Value> {
    let caller = &who.caller;
    let request = parse_request(body)?;
    let state = room_state(sql)?;
    let change =
        decide_set_visibility(caller, public_rooms_enabled, &state, &request).map_err(refusal)?;
    // The handle the room had, and the one it has after. Both go in the audit row, so an old link can always be traced to
    // its room after the room goes private or republishes. A handle is a public ID, so this stays ID-only.
    let prior_handle = state.room.public_handle.clone();
    let mut new_handle = prior_handle.clone();
    match change {
        VisibilityChange::NoChange => {}
        VisibilityChange::Publish => {
            let handle = public_handle_from(handle_bytes());
            exec(
                sql,
                "UPDATE workspace SET visibility = 'public', public_handle = ?, published_at = ?",
                vec![handle.as_str().into(), now.into()],
            )?;
            new_handle = Some(handle);
        }
        VisibilityChange::Unpublish { end_public_claims } => {
            // The handle is dropped for good: a republish makes a new one, so old links and copies can't come back.
            exec(
                sql,
                "UPDATE workspace SET visibility = 'private', public_handle = NULL, published_at = NULL",
                vec![],
            )?;
            new_handle = None;
            // Public claimants stay unless the owner ticked "also end public claims" (decision 151). Then each leaves through
            // the departure rules, in this transaction.
            if end_public_claims {
                super::public_claims::end_all(sql, caller, now)?;
            }
        }
    }
    if let (Some(event), Some(reason)) = (change.event_type(), change.audit_reason()) {
        let prior = if state.room.visibility == Visibility::Public {
            "public"
        } else {
            "private"
        };
        let new = if change == VisibilityChange::Publish {
            "public"
        } else {
            "private"
        };
        audit(
            sql,
            caller,
            reason,
            "workspace",
            Some(json!({ "visibility": prior, "public_handle": prior_handle }).to_string()),
            Some(json!({ "visibility": new, "public_handle": new_handle }).to_string()),
            now,
        )?;
        let mut everyone = room_people(sql)?;
        everyone.retain(|principal| *principal != caller.id);
        record_event(
            sql,
            event,
            &caller.id,
            None,
            &Transition::NONE,
            everyone,
            now,
        )?;
    }
    read(sql, who, public_rooms_enabled)
}

/// Sets or clears the room's topic, from the fixed list: the owner or a human admin.
pub(super) fn handle_set_topic(
    sql: &SqlStorage,
    caller: &Caller,
    body: &Value,
    now: i64,
) -> R<Value> {
    ApiError::from_verdict(authorize_workroom(caller, WorkroomAction::ManageRoom))?;
    let fields = body.as_object().ok_or_else(ApiError::invalid_argument)?;
    if fields.keys().any(|k| k != "topic") || !fields.contains_key("topic") {
        return Err(ApiError::invalid_argument());
    }
    let topic = match &body["topic"] {
        Value::Null => None,
        Value::String(name) => parse_topic(Some(name)).map_err(|_| ApiError::invalid_argument())?,
        _ => return Err(ApiError::invalid_argument()),
    };
    let prior = rows(sql, "SELECT topic FROM workspace", vec![])?
        .first()
        .and_then(|r| text(&r["topic"]));
    let new = topic.map(|t| t.name().to_string());
    if prior != new {
        exec(sql, "UPDATE workspace SET topic = ?", vec![opt(&new)])?;
        audit(
            sql,
            caller,
            "workspace.topic_changed",
            "workspace",
            Some(json!({ "topic": prior }).to_string()),
            Some(json!({ "topic": new }).to_string()),
            now,
        )?;
        let mut everyone = room_people(sql)?;
        everyone.retain(|principal| *principal != caller.id);
        record_event(
            sql,
            "workspace.topic_changed",
            &caller.id,
            None,
            &Transition::NONE,
            everyone,
            now,
        )?;
    }
    Ok(json!({ "topic": new }))
}

/// What the drain writes, as JSON, so it can tell whether anything changed since the last write.
fn index_json(row: &podster_policy::public::PublicIndexRow) -> Value {
    json!({
        "resolvable": row.resolvable, "listed": row.listed, "public_handle": row.public_handle, "topic": row.topic.map(Topic::name),
        "has_open_opening": row.has_open_opening, "published_at": row.published_at,
    })
}

/// The handle the room's latest publish made, from its audit row (step 5), so a tombstone names the handle that went away
/// rather than reading the room's current one. `None` for a room never published.
pub(super) fn last_published_handle(sql: &SqlStorage) -> R<Option<String>> {
    Ok(rows(
        sql,
        "SELECT new_json FROM audit_event WHERE action = 'visibility.published' ORDER BY seq DESC LIMIT 1",
        vec![],
    )?
    .first()
    .and_then(|r| r["new_json"].as_str().map(str::to_owned))
    .and_then(|j| serde_json::from_str::<Value>(&j).ok())
    .and_then(|v| v["public_handle"].as_str().map(str::to_owned)))
}

/// Writes the room's discovery row to `public_workroom_index` when an event marked it due (M4 step 6). The row is the room as
/// it stands, written with the newest `seq`, and D1 keeps a row only if its `seq` is newer, so a late or repeated write can't
/// restore an older one. A row that hasn't changed since the last write costs nothing. If D1 refuses the write because it
/// holds a newer `seq` (a lost, restored or reordered row), the cached copy is cleared, so the next event writes the row in
/// full. A failure leaves it due for the next alarm, and the alarm logs the error code and the room's ID only.
pub(super) async fn drain_public_index(sql: &SqlStorage, db: &D1Database) -> R<()> {
    if !store::is_initialized(sql)? || store::needs_migration(sql)? {
        return Ok(());
    }
    let Some(due) = rows(
        sql,
        "SELECT seq, written FROM public_index_outbox WHERE pending = 1",
        vec![],
    )?
    .into_iter()
    .next() else {
        return Ok(());
    };
    let seq = int(&due["seq"]);
    let state = room_state(sql)?;
    let row = podster_policy::public::index_row(&state, last_published_handle(sql)?.as_deref());
    // D1 keeps milliseconds, as the room does. The policy's row is in whole seconds, so the time comes from the column.
    let published_ms = if row.resolvable {
        rows(sql, "SELECT published_at FROM workspace", vec![])?
            .first()
            .and_then(|r| r["published_at"].as_i64())
    } else {
        None
    };
    let json = index_json(&row).to_string();
    let mut applied = true;
    if due["written"].as_str() != Some(json.as_str()) {
        let args: Vec<JsValue> = vec![
            state.room.workspace_id.as_str().into(),
            row.public_handle
                .as_deref()
                .map_or(JsValue::NULL, JsValue::from),
            row.topic
                .map(Topic::name)
                .map_or(JsValue::NULL, JsValue::from),
            JsValue::from_f64(f64::from(u8::from(row.has_open_opening))),
            published_ms.map_or(JsValue::NULL, |at| JsValue::from_f64(at as f64)),
            JsValue::from_f64(f64::from(u8::from(row.resolvable))),
            JsValue::from_f64(f64::from(u8::from(row.listed))),
            JsValue::from_f64(seq as f64),
        ];
        let result = db.prepare("INSERT INTO public_workroom_index (workspace_id, public_handle, topic, has_open_opening, published_at, resolvable, listed, updated_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT (workspace_id) DO UPDATE SET public_handle = excluded.public_handle, topic = excluded.topic, has_open_opening = excluded.has_open_opening,
                published_at = excluded.published_at, resolvable = excluded.resolvable, listed = excluded.listed, updated_seq = excluded.updated_seq
              WHERE excluded.updated_seq > public_workroom_index.updated_seq")
            .bind(&args)?
            .run()
            .await?;
        // No change means the seq guard refused it: D1 holds a newer seq than the room's.
        applied = result
            .meta()?
            .and_then(|meta| meta.changes)
            .is_none_or(|changes| changes > 0);
    }
    #[cfg(feature = "failpoints")]
    land_test_command(sql)?;
    // Only if nothing newer came in while the write was out: otherwise it stays due, and the next alarm writes that.
    exec(
        sql,
        "UPDATE public_index_outbox SET pending = 0, written = ? WHERE seq = ?",
        vec![
            if applied {
                json.as_str().into()
            } else {
                worker::SqlStorageValue::Null
            },
            seq.into(),
        ],
    )
}

/// Test builds only: a command marking the row due again while the D1 write was out, when a test asked for one.
#[cfg(feature = "failpoints")]
fn land_test_command(sql: &SqlStorage) -> R<()> {
    let asked = !rows(
        sql,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_index_inflight'",
        vec![],
    )?
    .is_empty();
    if asked {
        exec(sql, "DROP TABLE test_index_inflight", vec![])?;
        exec(
            sql,
            "UPDATE public_index_outbox SET seq = seq + 1, pending = 1",
            vec![],
        )?;
    }
    Ok(())
}

/// How often a room checks that its discovery row is still in D1 as it wrote it (M4 step 12, the reconcile step 6's review
/// asked for). A row lost or changed while the room's `written` copy still matches would otherwise never be written again.
pub(super) const INDEX_VERIFY_MS: i64 = 6 * 60 * 60 * 1000;
/// A confirmed tombstone changes only when the room writes something else, so it's checked weekly, which still repairs one that
/// drifted or was deleted.
pub(super) const TOMBSTONE_VERIFY_MS: i64 = 7 * 24 * 60 * 60 * 1000;
/// After a check fails, the next waits 5 s, doubling each time up to 30 minutes, plus up to a fifth more at random.
pub(super) const VERIFY_RETRY_FIRST_MS: i64 = 5_000;
pub(super) const VERIFY_RETRY_MAX_MS: i64 = 30 * 60 * 1000;
/// The room's key-value storage holds the schedule, so it survives a restart and needs no schema change: when the next check is
/// due, how many have failed in a row, and the cached row last confirmed as a tombstone, which is checked weekly until the room
/// writes something else.
pub(super) const VERIFY_NEXT_KEY: &str = "public_index_verify_next";
pub(super) const VERIFY_FAILURES_KEY: &str = "public_index_verify_failures";
pub(super) const VERIFIED_TOMBSTONE_KEY: &str = "public_index_verified_tombstone";

/// The wait after `failures` checks in a row have failed, with `jitter` from 0 to 1.
pub fn verify_backoff_ms(failures: u32, jitter: f64) -> i64 {
    let doublings = failures.saturating_sub(1).min(20);
    let base = VERIFY_RETRY_FIRST_MS
        .saturating_mul(1_i64 << doublings)
        .min(VERIFY_RETRY_MAX_MS);
    base + (base as f64 * 0.2 * jitter.clamp(0.0, 1.0)) as i64
}

/// What the room has to check: the copy it last wrote (empty if a write was refused), once it has a discovery row and no
/// write is due, which would rewrite it anyway. `None` when there's nothing to check.
pub(super) fn index_to_check(sql: &SqlStorage) -> R<Option<String>> {
    if !store::is_initialized(sql)? || store::needs_migration(sql)? {
        return Ok(None);
    }
    let found = rows(
        sql,
        "SELECT pending, written FROM public_index_outbox",
        vec![],
    )?;
    Ok(found
        .first()
        .filter(|row| int(&row["pending"]) == 0)
        .map(|row| row["written"].as_str().unwrap_or("").to_string()))
}

pub(super) enum IndexCheck {
    /// D1 holds what the room wrote. `tombstone` is set when that's a row nobody can resolve, which is checked weekly from
    /// then until the room writes something else.
    Matches { tombstone: bool },
    /// It was missing or different, and is due to be written again.
    Repaired,
}

/// The D1 row in `index_json`'s shape, to compare with what the room wrote. Times are compared in whole seconds, as the policy
/// keeps them, and only while the row is resolvable, since that's the only time the room writes one.
fn d1_row_json(row: &Value) -> Value {
    let flag = |name: &str| row[name].as_f64().is_some_and(|n| n != 0.0);
    let resolvable = flag("resolvable");
    json!({
        "resolvable": resolvable, "listed": flag("listed"), "public_handle": row["public_handle"], "topic": row["topic"],
        "has_open_opening": flag("has_open_opening"),
        "published_at": if resolvable { row["published_at"].as_f64().map_or(Value::Null, |ms| json!((ms as i64).div_euclid(1000))) } else { Value::Null },
    })
}

fn comparable(written: &str) -> Option<Value> {
    let mut value: Value = serde_json::from_str(written).ok()?;
    if value["resolvable"] != json!(true) {
        value["published_at"] = Value::Null;
    }
    Some(value)
}

/// Reads the room's discovery row from D1 and compares it, field by field, with what the room last wrote. Anything else, a
/// missing row, a changed one or one newer than the room's, is deleted and marked due, so the next drain writes it in full and
/// a drifted row fails closed meanwhile: only this room writes its row, and the room's state decides.
pub(super) async fn verify_public_index(
    sql: &SqlStorage,
    db: &D1Database,
) -> R<Option<IndexCheck>> {
    let Some(written) = index_to_check(sql)? else {
        return Ok(None);
    };
    let room = super::objects::room_id(sql)?;
    let found = db
        .prepare("SELECT public_handle, topic, has_open_opening, published_at, resolvable, listed FROM public_workroom_index WHERE workspace_id = ?")
        .bind(&[room.as_str().into()])?
        .first::<Value>(None)
        .await?;
    let expected = comparable(&written);
    if let (Some(row), Some(expected)) = (&found, &expected) {
        if d1_row_json(row) == *expected {
            return Ok(Some(IndexCheck::Matches {
                tombstone: expected["resolvable"] != json!(true),
            }));
        }
    }
    if found.is_some() {
        db.prepare("DELETE FROM public_workroom_index WHERE workspace_id = ?")
            .bind(&[room.as_str().into()])?
            .run()
            .await?;
    }
    exec(
        sql,
        "UPDATE public_index_outbox SET pending = 1, written = NULL WHERE pending = 0",
        vec![],
    )?;
    Ok(Some(IndexCheck::Repaired))
}

/// Whether the discovery row is due, for the alarm.
pub(super) fn public_index_due(sql: &SqlStorage) -> R<bool> {
    Ok(store::is_initialized(sql)?
        && !store::needs_migration(sql)?
        && !rows(
            sql,
            "SELECT seq FROM public_index_outbox WHERE pending = 1",
            vec![],
        )?
        .is_empty())
}
