//! A release's build, and publishing the build that was tested (M8 step 9; the preview plan, `docs/m8-preview-plan.md`,
//! sections 4.1 to 4.3 and 5.2.1; decisions 254, 255 and 259).
//!
//! **Every release's build is recorded,** a preview's and production's alike, by the job, once its first pass has
//! fetched every file and checked it against the tree, and before anything is sent to the provider or a store is made
//! (`release_upload`): its build ID, computed by `podster_core::preview_build::build_id_of` from what was fetched, the
//! release directory's tree, Podster's upload form, and whether any of its text files names browser storage (the
//! storage warning, which never blocks). The second pass that sends each file checks it hashes as the first pass did, so
//! what is uploaded is what the build names.
//!
//! **A production release made from a preview** names that preview release and its build (`release_from_preview`,
//! Workspace step 61), both fixed when it is asked for ([`preview_source`]). Its job recomputes the build from what it
//! fetched and fails the release `build_mismatch` on any difference ([`record`]), before anything is uploaded; and the
//! commit live checks once more that the build recorded is the one named ([`publish_holds`]). A failed release is any
//! failed release: the production release that is live stays live.
//!
//! **An approval is valid only for its own build** ([`approval_build`]): the build it sends back is compared with the
//! one the release names, never with the slot's preview now, so replacing the preview never moves it (decision 259).
//!
//! Logs carry IDs and codes only.
use super::*;
use podster_core::preview_build::{
    publish_build_check, publish_source, ApprovalBuildRefusal, PreviewPublishRefusal,
    PreviewReleaseRecord, PublishSource, UPLOAD_FORM,
};
use podster_core::release::ReleaseState;

/// What a production release made from a preview names: the preview release and its build.
pub(super) struct FromPreview {
    pub(super) preview_release_id: String,
    pub(super) build_id: String,
}

/// The preview release and build a release names, if it was made from a preview.
pub(super) fn from_preview(sql: &SqlStorage, release_id: &str) -> R<Option<FromPreview>> {
    Ok(rows(
        sql,
        "SELECT preview_release_id, build_id FROM release_from_preview WHERE release_id = ?",
        vec![release_id.into()],
    )?
    .first()
    .and_then(|row| {
        Some(FromPreview {
            preview_release_id: text(&row["preview_release_id"])?,
            build_id: text(&row["build_id"])?,
        })
    }))
}

/// The build ID the job recorded for a release, if it has fetched the build.
pub(super) fn build_of(sql: &SqlStorage, release_id: &str) -> R<Option<String>> {
    Ok(rows(
        sql,
        "SELECT build_id FROM release_build WHERE release_id = ?",
        vec![release_id.into()],
    )?
    .first()
    .and_then(|row| text(&row["build_id"])))
}

/// The storage warning of a release's build: `None` until the job has fetched it.
pub(super) fn storage_of(sql: &SqlStorage, release_id: &str) -> R<Option<bool>> {
    Ok(rows(
        sql,
        "SELECT names_storage FROM release_build_storage WHERE release_id = ?",
        vec![release_id.into()],
    )?
    .first()
    .map(|row| int(&row["names_storage"]) == 1))
}

/// A refusal of a publish, as `requestRelease` answers it: a release that isn't a preview's is answered as one the room
/// doesn't have (404); the rest are 409.
fn publish_refused(refusal: PreviewPublishRefusal) -> ApiError {
    let status = match refusal {
        PreviewPublishRefusal::NotPreview => 404,
        _ => 409,
    };
    let code = refusal.code();
    // error-codes: preview_release_not_found, preview_not_served, preview_build_missing, preview_task_mismatch, preview_commit_mismatch
    ApiError::api(status, code)
}

/// **What a publish names** (the plan's 4.3): the preview release `from_preview`, on the room's own rows, which must be
/// a preview release that reached `served` with its build recorded, of the very task and commit asked for
/// (`podster_core::preview_build::publish_source`). One the room doesn't have is `preview_release_not_found` (404), as
/// a production release is. The commit is still checked by the request's own rules after this.
pub(super) fn preview_source(
    sql: &SqlStorage,
    from_preview: &str,
    task_id: &str,
    commit_sha: &str,
) -> R<(String, String)> {
    let found = rows(
        sql,
        "SELECT id, task_id, commit_sha, state, served_at FROM release WHERE id = ?",
        vec![from_preview.into()],
    )?;
    let Some(row) = found.first() else {
        return Err(publish_refused(PreviewPublishRefusal::NotPreview));
    };
    let state = row["state"]
        .as_str()
        .and_then(|name| ReleaseState::ALL.into_iter().find(|s| s.name() == name))
        .ok_or_else(|| ApiError::internal("a release in no state"))?;
    let build = build_of(sql, from_preview)?;
    let (id, task, commit) = (
        text(&row["id"]).unwrap_or_default(),
        text(&row["task_id"]).unwrap_or_default(),
        text(&row["commit_sha"]).unwrap_or_default(),
    );
    let record = PreviewReleaseRecord {
        environment: super::preview::environment_of(sql, from_preview)?,
        release_id: &id,
        task_id: &task,
        commit_sha: &commit,
        state,
        served_at: row["served_at"].as_i64(),
        build_id: build.as_deref(),
    };
    let PublishSource {
        preview_release_id,
        build_id,
        ..
    } = publish_source(&record, task_id, commit_sha).map_err(publish_refused)?;
    Ok((preview_release_id.to_owned(), build_id.to_owned()))
}

/// What a release made from a preview records beside it, in the request's transaction: the preview release and its
/// build, fixed from now on.
pub(super) fn record_source(
    sql: &SqlStorage,
    release_id: &str,
    preview_release_id: &str,
    build_id: &str,
) -> R<()> {
    exec(
        sql,
        "INSERT INTO release_from_preview (release_id, preview_release_id, build_id) VALUES (?, ?, ?)",
        vec![
            release_id.into(),
            preview_release_id.into(),
            build_id.into(),
        ],
    )
}

/// **An approval's build** (decision 259): `sent` is the body's `build`, which a release made from a preview requires
/// and any other release refuses. One that isn't the release's own is `release_build_changed` (409).
pub(super) fn approval_build(sql: &SqlStorage, release_id: &str, sent: Option<&str>) -> R<()> {
    let named = from_preview(sql, release_id)?;
    podster_core::preview_build::approval_build(
        named.as_ref().map(|source| source.build_id.as_str()),
        sent,
    )
    .map_err(|refusal| {
        let status = match refusal {
            ApprovalBuildRefusal::BuildChanged => 409,
            _ => 400,
        };
        let code = refusal.code();
        // error-codes: release_build_changed, invalid_argument
        ApiError::api(status, code)
    })
}

/// The body `approveRelease` takes: nothing, or `{ build }` and nothing else. Any other is `invalid_argument`.
pub(super) fn approval_body(body: &Value) -> R<Option<String>> {
    let fields = body.as_object().ok_or_else(ApiError::invalid_argument)?;
    if fields.keys().any(|key| key != "build") {
        return Err(ApiError::invalid_argument());
    }
    match fields.get("build") {
        None => Ok(None),
        Some(build) => build
            .as_str()
            .map(|build| Some(build.to_owned()))
            .ok_or_else(ApiError::invalid_argument),
    }
}

/// **The build the job fetched, recorded,** in the room's transaction, while the release is still uploading: its ID,
/// tree and Podster's upload form, and its storage warning. For a release made from a preview, the build must be the
/// one it names, or the answer is `build_mismatch`, for the caller to fail the release by, and nothing is recorded.
/// Asked again, the same build is recorded again. A release no longer uploading records nothing.
pub(super) fn record(
    sql: &SqlStorage,
    release_id: &str,
    build_id: &str,
    tree: &str,
    names_storage: bool,
) -> R<std::result::Result<(), &'static str>> {
    let state = rows(
        sql,
        "SELECT state FROM release WHERE id = ?",
        vec![release_id.into()],
    )?
    .first()
    .and_then(|row| text(&row["state"]));
    if state.as_deref() != Some(ReleaseState::Uploading.name()) {
        return Ok(Ok(()));
    }
    if let Some(source) = from_preview(sql, release_id)? {
        if let Err(mismatch) = publish_build_check(&source.build_id, build_id) {
            console_log!(
                "release: a publish's build isn't the one tested: release={} preview={} code={}",
                release_id,
                source.preview_release_id,
                mismatch.code()
            );
            return Ok(Err(mismatch.code()));
        }
    }
    exec(
        sql,
        "INSERT INTO release_build (release_id, build_id, tree_sha, form_version) VALUES (?, ?, ?, ?)
           ON CONFLICT (release_id) DO UPDATE SET build_id = excluded.build_id, tree_sha = excluded.tree_sha,
             form_version = excluded.form_version",
        vec![
            release_id.into(),
            build_id.into(),
            tree.into(),
            UPLOAD_FORM.text().into(),
        ],
    )?;
    exec(
        sql,
        "INSERT INTO release_build_storage (release_id, names_storage) VALUES (?, ?)
           ON CONFLICT (release_id) DO UPDATE SET names_storage = excluded.names_storage",
        vec![release_id.into(), flag(names_storage)],
    )?;
    Ok(Ok(()))
}

/// **Whether a production release may go live on its build** (the plan's 4.3, "before commit live"): one not made
/// from a preview always may; one made from a preview only once its job recorded exactly the build it names.
pub(super) fn publish_holds(sql: &SqlStorage, release_id: &str) -> R<bool> {
    let Some(source) = from_preview(sql, release_id)? else {
        return Ok(true);
    };
    Ok(build_of(sql, release_id)?
        .is_some_and(|recorded| publish_build_check(&source.build_id, &recorded).is_ok()))
}

/// What the approval list shows of a release made from a preview (the plan's section 10), and nulls for any other:
/// the preview release and its build, when that build reached the preview, its storage warning, whether the preview now
/// shows another build (a newer release of the same build isn't one), and the dialog's words.
pub(super) fn approval_view(sql: &SqlStorage, release_id: &str) -> R<Value> {
    let Some(source) = from_preview(sql, release_id)? else {
        return Ok(json!({
            "from_preview": Value::Null, "build_id": Value::Null, "preview_served_at": Value::Null,
            "storage_warning": Value::Null, "preview_replaced": Value::Null, "preview_notice": Value::Null,
            "storage_notice": Value::Null,
        }));
    };
    let served_at = rows(
        sql,
        "SELECT served_at FROM release WHERE id = ?",
        vec![source.preview_release_id.as_str().into()],
    )?
    .first()
    .and_then(|row| row["served_at"].as_i64());
    let storage = storage_of(sql, &source.preview_release_id)?;
    let serving = super::preview::serving_now(sql)?;
    // Replaced means the preview now shows another *build*, or none: a newer preview release of the very same build
    // (the same commit asked for again) shows exactly what is being approved.
    let serving_build = match serving.as_deref() {
        Some(id) => build_of(sql, id)?,
        None => None,
    };
    let replaced = serving_build.as_deref() != Some(source.build_id.as_str());
    let warned = storage == Some(true);
    Ok(json!({
        "from_preview": source.preview_release_id,
        "build_id": source.build_id,
        "preview_served_at": served_at,
        "storage_warning": storage,
        "preview_replaced": replaced,
        "preview_notice": podster_core::preview_build::PREVIEW_DIFFERENCES_NOTICE,
        "storage_notice": if warned { Value::from(podster_core::preview_build::STORAGE_WARNING_NOTICE) } else { Value::Null },
    }))
}
