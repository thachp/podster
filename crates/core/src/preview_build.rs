//! The build ID, and publishing the build that was tested (M8 step 4; the preview plan, `docs/m8-preview-plan.md`,
//! sections 4.1 to 4.3; decisions 254 and 259). Pure, with no I/O: SHA-256 is arithmetic.
//!
//! **What a build is** (the plan's 4.1). Podster builds nothing; built files are committed (decision 220, answer 3).
//! So a build is fully named by what the job fetched and verified, and by Podster's own upload form. Its ID is
//! `bld_` and the first 32 lower-case hexadecimal characters of a SHA-256 over [`build_text`]:
//!
//! ```text
//! podster-build/1
//! form <COMPATIBILITY_DATE> <ASSETS_CONFIG> <STORE_BINDING_NAME> <MODULE_UPLOAD_TYPE>
//! commit <commit>
//! tree <git tree of the release directory>
//! file <served path> <manifest hash>        (sorted by path; every served file but Podster's marker)
//! module <name> <SHA-256 of its bytes>      (sorted by name)
//! main <entry module, or "-">
//! store <yes|no>
//! ```
//!
//! Left out on purpose: the script name, the label, the store's database ID and Podster's marker body, which are all
//! that differ between a preview's upload and production's upload of the same commit. Included on purpose: Podster's
//! upload form, so a change to `COMPATIBILITY_DATE` between preview and publish changes the build, and publishing asks
//! for a new preview.
//!
//! **Why the text can't be read two ways.** Every part is checked for its form before it is written: commits and trees
//! are hexadecimal, hashes fixed-length hexadecimal, module names [`crate::app_code::module_name_form`] (no space), paths
//! [`crate::release_tree::check_path`] (no control character, so no line break), form parts without a space or a line
//! break. A
//! path may hold a space, but it is always followed by exactly one space and a fixed-length hash at the end of its
//! line, so each line reads back one way. Duplicates are refused, and lines are sorted, so order never matters.
//!
//! **The publish binding** (the plan's 4.3; decision 259): a publish names an immutable preview release that reached
//! `served`, never a commit or the slot ([`publish_source`]); its approval must send back exactly that release's build
//! ([`approval_build`]); and the production job recomputes the build from what it fetched and goes live only on a match
//! ([`publish_build_check`]). Replacing the preview never moves a pending approval, since none of these reads the slot.
//!
//! **What the job records** (M8 step 9): [`build_id_of`] names the build from what the job's first pass fetched and
//! checked, as the upload will send it; [`names_browser_storage`] is the plan's storage warning (5.2.1), a string search
//! of the build's text that never blocks; and [`STORAGE_WARNING_NOTICE`] and [`PREVIEW_DIFFERENCES_NOTICE`] are the
//! words the approval dialog shows (the plan's section 10).
//!
//! **Codes.** A refusal of a publish or of an approval's build reaches a caller as `error.code`
//! (`requestRelease`, `approveRelease`), so those are marked `errors`; the rest are reasons.

use sha2::{Digest, Sha256};

use crate::app_code::{
    module_name_form, UploadForm, ASSETS_CONFIG, COMPATIBILITY_DATE, MODULE_UPLOAD_TYPE,
    STORE_BINDING_NAME,
};
use crate::preview::Environment;
use crate::release::ReleaseState;
use crate::release_tree::{check_path, MARKER_PATH};
use crate::repositories::valid_commit_sha;

/// Before every build ID.
pub const BUILD_ID_PREFIX: &str = "bld_";
/// The first line of every build's text: the text's own version, so a later form can never collide with this one.
pub const BUILD_FORMAT: &str = "podster-build/1";
/// The hexadecimal characters of the SHA-256 a build ID keeps: 128 bits.
pub const BUILD_ID_HEX: usize = 32;

/// Podster's upload form: the parts of every script's upload that Podster, never a repository, decides (the plan's 4.1).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct UploadFormVersion<'a> {
    pub compatibility_date: &'a str,
    pub assets_config: &'a str,
    pub store_binding_name: &'a str,
    pub module_upload_type: &'a str,
}

impl UploadFormVersion<'_> {
    /// Its four parts, joined by single spaces, as the form's line of [`build_text`] has them: what the room records
    /// beside a build (`release_build.form_version`).
    pub fn text(&self) -> String {
        [
            self.compatibility_date,
            self.assets_config,
            self.store_binding_name,
            self.module_upload_type,
        ]
        .join(" ")
    }
}

/// The upload form every script is written with now, from [`crate::app_code`]'s constants.
pub const UPLOAD_FORM: UploadFormVersion<'static> = UploadFormVersion {
    compatibility_date: COMPATIBILITY_DATE,
    assets_config: ASSETS_CONFIG,
    store_binding_name: STORE_BINDING_NAME,
    module_upload_type: MODULE_UPLOAD_TYPE,
};

/// One served file: its path relative to the release directory, and its manifest hash, the 32 lower-case hexadecimal
/// characters [`crate::release_tree::manifest_hash`] makes from a SHA-256 over its type and bytes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BuildFile<'a> {
    pub path: &'a str,
    pub manifest_hash: &'a str,
}

/// One module of a release with code: its name and the SHA-256 of its bytes, 64 lower-case hexadecimal characters.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BuildModule<'a> {
    pub name: &'a str,
    pub sha256: &'a str,
}

/// Everything a build is named by, as the job fetched and checked it: after the tree check and each file's git blob
/// check, never before.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BuildInputs<'a> {
    pub commit: &'a str,
    /// The git tree SHA of the release directory at that commit.
    pub tree: &'a str,
    /// Every served file. Podster's own marker at [`MARKER_PATH`], if given, is left out.
    pub files: &'a [BuildFile<'a>],
    /// Every module; none for a static release.
    pub modules: &'a [BuildModule<'a>],
    /// The entry module; `None` for a static release.
    pub main: Option<&'a str>,
    /// Whether the release asks for a store.
    pub store: bool,
}

/// Why no build ID can be made from what was given. Each is a fault in the caller, never something a repository's
/// author can cause once the release tree's own checks have passed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BuildRefusal {
    /// `build_commit_invalid`
    Commit,
    /// `build_tree_invalid`
    Tree,
    /// `build_path_invalid`: a path the release tree's rule refuses.
    Path,
    /// `build_manifest_hash_invalid`: not 32 lower-case hexadecimal characters.
    ManifestHash,
    /// `build_path_repeated`
    DuplicatePath,
    /// `build_module_name_invalid`
    ModuleName,
    /// `build_module_hash_invalid`: not 64 lower-case hexadecimal characters.
    ModuleHash,
    /// `build_module_repeated`
    DuplicateModule,
    /// `build_main_invalid`: an entry that isn't one of the modules, modules with no entry, or an entry with none.
    Main,
    /// `build_store_invalid`: a store asked for by a release with no code.
    Store,
    /// `build_form_invalid`: a part of the upload form that is empty or holds a space, a line break or a control
    /// character.
    Form,
}

impl BuildRefusal {
    pub const ALL: [BuildRefusal; 11] = [
        BuildRefusal::Commit,
        BuildRefusal::Tree,
        BuildRefusal::Path,
        BuildRefusal::ManifestHash,
        BuildRefusal::DuplicatePath,
        BuildRefusal::ModuleName,
        BuildRefusal::ModuleHash,
        BuildRefusal::DuplicateModule,
        BuildRefusal::Main,
        BuildRefusal::Store,
        BuildRefusal::Form,
    ];

    // codes: reasons
    pub fn code(self) -> &'static str {
        match self {
            BuildRefusal::Commit => "build_commit_invalid",
            BuildRefusal::Tree => "build_tree_invalid",
            BuildRefusal::Path => "build_path_invalid",
            BuildRefusal::ManifestHash => "build_manifest_hash_invalid",
            BuildRefusal::DuplicatePath => "build_path_repeated",
            BuildRefusal::ModuleName => "build_module_name_invalid",
            BuildRefusal::ModuleHash => "build_module_hash_invalid",
            BuildRefusal::DuplicateModule => "build_module_repeated",
            BuildRefusal::Main => "build_main_invalid",
            BuildRefusal::Store => "build_store_invalid",
            BuildRefusal::Form => "build_form_invalid",
        }
    }
}

fn lower_hex(text: &str, len: usize) -> bool {
    text.len() == len && text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// A part of the upload form as it goes on the form's line: not empty, and no space, line break or other white space
/// or control character, since the line's parts are joined by single spaces and must read back one way.
fn form_part(part: &str) -> bool {
    !part.is_empty() && !part.chars().any(|c| c.is_whitespace() || c.is_control())
}

/// The canonical text a build ID is the SHA-256 of (the plan's 4.1), or why it can't be made. Public so a reviewer,
/// and the tests, can see exactly what is hashed.
pub fn build_text(form: &UploadFormVersion, inputs: &BuildInputs) -> Result<String, BuildRefusal> {
    let form_parts = [
        form.compatibility_date,
        form.assets_config,
        form.store_binding_name,
        form.module_upload_type,
    ];
    if !form_parts.iter().all(|part| form_part(part)) {
        return Err(BuildRefusal::Form);
    }
    if !valid_commit_sha(inputs.commit) {
        return Err(BuildRefusal::Commit);
    }
    if !valid_commit_sha(inputs.tree) {
        return Err(BuildRefusal::Tree);
    }
    let mut files: Vec<&BuildFile> = inputs
        .files
        .iter()
        .filter(|file| file.path != MARKER_PATH)
        .collect();
    for file in &files {
        if check_path(file.path).is_err() {
            return Err(BuildRefusal::Path);
        }
        if !lower_hex(file.manifest_hash, 32) {
            return Err(BuildRefusal::ManifestHash);
        }
    }
    files.sort_by(|a, b| a.path.as_bytes().cmp(b.path.as_bytes()));
    if files
        .windows(2)
        .any(|pair| matches!(pair, [a, b] if a.path == b.path))
    {
        return Err(BuildRefusal::DuplicatePath);
    }
    let mut modules: Vec<&BuildModule> = inputs.modules.iter().collect();
    for module in &modules {
        if !module_name_form(module.name) {
            return Err(BuildRefusal::ModuleName);
        }
        if !lower_hex(module.sha256, 64) {
            return Err(BuildRefusal::ModuleHash);
        }
    }
    modules.sort_by(|a, b| a.name.as_bytes().cmp(b.name.as_bytes()));
    if modules
        .windows(2)
        .any(|pair| matches!(pair, [a, b] if a.name == b.name))
    {
        return Err(BuildRefusal::DuplicateModule);
    }
    let main_ok = match inputs.main {
        Some(main) => modules.iter().any(|m| m.name == main),
        None => modules.is_empty(),
    };
    if !main_ok {
        return Err(BuildRefusal::Main);
    }
    if inputs.store && modules.is_empty() {
        return Err(BuildRefusal::Store);
    }

    let mut text = String::new();
    let mut line = |parts: &[&str]| {
        text.push_str(&parts.join(" "));
        text.push('\n');
    };
    line(&[BUILD_FORMAT]);
    line(&[
        "form",
        form.compatibility_date,
        form.assets_config,
        form.store_binding_name,
        form.module_upload_type,
    ]);
    line(&["commit", inputs.commit]);
    line(&["tree", inputs.tree]);
    for file in files {
        line(&["file", file.path, file.manifest_hash]);
    }
    for module in modules {
        line(&["module", module.name, module.sha256]);
    }
    line(&["main", inputs.main.unwrap_or("-")]);
    line(&["store", if inputs.store { "yes" } else { "no" }]);
    Ok(text)
}

/// The build ID under a given upload form. [`build_id`] is this under [`UPLOAD_FORM`]; this exists so a change of form
/// can be shown to change the build.
pub fn build_id_with_form(
    form: &UploadFormVersion,
    inputs: &BuildInputs,
) -> Result<String, BuildRefusal> {
    let text = build_text(form, inputs)?;
    let digest = Sha256::digest(text.as_bytes());
    let hex: String = digest
        .iter()
        .take(BUILD_ID_HEX / 2)
        .map(|b| format!("{b:02x}"))
        .collect();
    Ok(format!("{BUILD_ID_PREFIX}{hex}"))
}

/// The build ID of what the job fetched, under Podster's upload form now.
pub fn build_id(inputs: &BuildInputs) -> Result<String, BuildRefusal> {
    build_id_with_form(&UPLOAD_FORM, inputs)
}

/// Whether text is a build ID: exactly `bld_` and 32 lower-case hexadecimal characters (the contract's
/// `^bld_[0-9a-f]{32}$`).
pub fn is_build_id(text: &str) -> bool {
    text.strip_prefix(BUILD_ID_PREFIX)
        .is_some_and(|hex| lower_hex(hex, BUILD_ID_HEX))
}

// ---------------------------------------------------------------------------------------------------------------------
// The publish binding (the plan's 4.3; decisions 254 and 259)
// ---------------------------------------------------------------------------------------------------------------------

/// A release record named by a publish's `from_preview`, as the room holds it. Each field is the room's own, never the
/// caller's.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PreviewReleaseRecord<'a> {
    pub environment: Environment,
    pub release_id: &'a str,
    pub task_id: &'a str,
    pub commit_sha: &'a str,
    pub state: ReleaseState,
    /// When its marker came back through the preview host, if it did.
    pub served_at: Option<i64>,
    /// Its build ID, recorded by the job once it fetched and checked the tree (`release_build`, Workspace step 61).
    pub build_id: Option<&'a str>,
}

/// What a production release made from a preview records (`release_from_preview`, Workspace step 61): the preview
/// release and its build, both immutable, and the commit taken from it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PublishSource<'a> {
    pub preview_release_id: &'a str,
    pub build_id: &'a str,
    pub commit_sha: &'a str,
}

/// Why a publish can't be made from the preview release it names.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PreviewPublishRefusal {
    /// `preview_release_not_found`: the release named is a production release. Answered as if there were none.
    NotPreview,
    /// `preview_not_served`: its marker never came back through the preview host, so it was never tested.
    NotServed,
    /// `preview_build_missing`: no build ID of the right form was recorded for it.
    NoBuild,
    /// `preview_task_mismatch`: the publish names another task than the preview release's.
    TaskMismatch,
    /// `preview_commit_mismatch`: the publish names another commit than the preview release's.
    CommitMismatch,
}

impl PreviewPublishRefusal {
    pub const ALL: [PreviewPublishRefusal; 5] = [
        PreviewPublishRefusal::NotPreview,
        PreviewPublishRefusal::NotServed,
        PreviewPublishRefusal::NoBuild,
        PreviewPublishRefusal::TaskMismatch,
        PreviewPublishRefusal::CommitMismatch,
    ];

    // codes: errors
    pub fn code(self) -> &'static str {
        match self {
            PreviewPublishRefusal::NotPreview => "preview_release_not_found",
            PreviewPublishRefusal::NotServed => "preview_not_served",
            PreviewPublishRefusal::NoBuild => "preview_build_missing",
            PreviewPublishRefusal::TaskMismatch => "preview_task_mismatch",
            PreviewPublishRefusal::CommitMismatch => "preview_commit_mismatch",
        }
    }
}

/// Whether a preview release may be published, and what the production release records if so (the plan's 4.3): a
/// preview release that **reached `served`** (its marker came back, so it was tested), with its build ID recorded, of
/// the very task and commit the publish names. It stays publishable once replaced or deleted (decision 259: that
/// build was tested), so `served`, `replaced` and `unpublished` all count, each with `served_at` recorded; no other
/// state was ever served. The commit is still checked by `release::releasable_commit` and every production rule still
/// applies (a public room among them, decision 251); those are the request's, not this.
pub fn publish_source<'a>(
    record: &PreviewReleaseRecord<'a>,
    task_id: &str,
    commit_sha: &str,
) -> Result<PublishSource<'a>, PreviewPublishRefusal> {
    if record.environment != Environment::Preview {
        return Err(PreviewPublishRefusal::NotPreview);
    }
    let reached_served = matches!(
        record.state,
        ReleaseState::Served | ReleaseState::Replaced | ReleaseState::Unpublished
    ) && record.served_at.is_some();
    if !reached_served {
        return Err(PreviewPublishRefusal::NotServed);
    }
    let build_id = record
        .build_id
        .filter(|id| is_build_id(id))
        .ok_or(PreviewPublishRefusal::NoBuild)?;
    if record.task_id != task_id {
        return Err(PreviewPublishRefusal::TaskMismatch);
    }
    if record.commit_sha != commit_sha {
        return Err(PreviewPublishRefusal::CommitMismatch);
    }
    Ok(PublishSource {
        preview_release_id: record.release_id,
        build_id,
        commit_sha: record.commit_sha,
    })
}

/// Why an approval's body doesn't fit the release it approves.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApprovalBuildRefusal {
    /// `release_build_changed` (409): the build sent isn't the release's. The approver was shown something else.
    BuildChanged,
    /// `invalid_argument` (400): a release made from a preview, approved with no build.
    BuildRequired,
    /// `invalid_argument` (400): a body sent for a release not made from a preview, which takes none.
    BodyNotTaken,
}

impl ApprovalBuildRefusal {
    // codes: errors
    pub fn code(self) -> &'static str {
        match self {
            ApprovalBuildRefusal::BuildChanged => "release_build_changed",
            ApprovalBuildRefusal::BuildRequired | ApprovalBuildRefusal::BodyNotTaken => {
                "invalid_argument"
            }
        }
    }
}

/// **An approval is valid only for its own build** (decision 259; the plan's 4.3, "The approval is bound to the
/// build"). `release_build` is the build the production release recorded from its preview release
/// ([`PublishSource::build_id`]), `None` for a release not made from one; `sent` is the body's `build`. The slot's
/// current preview is never an input, so replacing the preview can't move an approval: a pending publish stays valid
/// for its build, and only for it.
pub fn approval_build(
    release_build: Option<&str>,
    sent: Option<&str>,
) -> Result<(), ApprovalBuildRefusal> {
    match (release_build, sent) {
        (None, None) => Ok(()),
        (None, Some(_)) => Err(ApprovalBuildRefusal::BodyNotTaken),
        (Some(_), None) => Err(ApprovalBuildRefusal::BuildRequired),
        (Some(recorded), Some(sent)) if recorded == sent && is_build_id(recorded) => Ok(()),
        (Some(_), Some(_)) => Err(ApprovalBuildRefusal::BuildChanged),
    }
}

/// `build_mismatch`: what the production job fetched isn't the build that was tested and approved.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BuildMismatch;

impl BuildMismatch {
    // codes: reasons
    pub fn code(self) -> &'static str {
        "build_mismatch"
    }
}

/// **The production job goes live only on the recorded build** (the plan's 4.3): after the tree check and before commit
/// live, it recomputes the build ID from what it fetched ([`build_id`]) and compares it with the one recorded from the
/// preview. Any difference, or an ID of the wrong form on either side, fails the release `build_mismatch`, and the
/// current production release stays live.
pub fn publish_build_check(recorded: &str, recomputed: &str) -> Result<(), BuildMismatch> {
    if is_build_id(recorded) && recorded == recomputed {
        Ok(())
    } else {
        Err(BuildMismatch)
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// What the job records of a build (M8 step 9; the plan's 4.1 and 5.2.1), and the dialog's words (section 10)
// ---------------------------------------------------------------------------------------------------------------------

/// One file as the job's first pass fetched it and checked it against the tree: its path relative to the release
/// directory, its manifest hash and the SHA-256 of its bytes, 64 lower-case hexadecimal characters.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FetchedFile<'a> {
    pub path: &'a str,
    pub manifest_hash: &'a str,
    pub sha256: &'a str,
}

/// **The build of what the job fetched, as its upload will send it** (the plan's 4.1): under Podster's upload form now,
/// every file a static release has; for one with code, its static files by their manifest hashes, its modules by the
/// SHA-256 of their bytes, its entry and whether it asks for its store, and never its manifest, which is neither served
/// nor a module. A file the form names that the job didn't fetch has no build: [`BuildRefusal::Path`] for a static
/// file, [`BuildRefusal::ModuleHash`] for a module.
pub fn build_id_of(
    form: &UploadForm,
    commit: &str,
    tree: &str,
    fetched: &[FetchedFile],
) -> Result<String, BuildRefusal> {
    let find = |path: &str| fetched.iter().find(|file| file.path == path);
    match form {
        UploadForm::Static => {
            let files: Vec<BuildFile> = fetched
                .iter()
                .map(|file| BuildFile {
                    path: file.path,
                    manifest_hash: file.manifest_hash,
                })
                .collect();
            build_id(&BuildInputs {
                commit,
                tree,
                files: &files,
                modules: &[],
                main: None,
                store: false,
            })
        }
        UploadForm::Code(release) => {
            let files = release
                .static_files
                .iter()
                .map(|planned| {
                    find(&planned.path)
                        .map(|file| BuildFile {
                            path: file.path,
                            manifest_hash: file.manifest_hash,
                        })
                        .ok_or(BuildRefusal::Path)
                })
                .collect::<Result<Vec<BuildFile>, BuildRefusal>>()?;
            let modules = release
                .modules
                .iter()
                .map(|module| {
                    find(&module.file.path)
                        .map(|file| BuildModule {
                            name: &module.name,
                            sha256: file.sha256,
                        })
                        .ok_or(BuildRefusal::ModuleHash)
                })
                .collect::<Result<Vec<BuildModule>, BuildRefusal>>()?;
            build_id(&BuildInputs {
                commit,
                tree,
                files: &files,
                modules: &modules,
                main: Some(&release.main),
                store: release.wants_store,
            })
        }
    }
}

/// The names the storage warning searches a build's text for (the plan's 5.2.1).
pub const STORAGE_NAMES: [&str; 5] = [
    "localStorage",
    "sessionStorage",
    "indexedDB",
    "document.cookie",
    "caches.open",
];

/// **Whether a file of the build may use browser storage** (the plan's 5.2.1): a file that is UTF-8 text and names one of
/// [`STORAGE_NAMES`], exactly. A string search of agent content, treated as data and never as an instruction: it never
/// blocks anything, will miss storage reached another way, and will flag a name that is only mentioned.
pub fn names_browser_storage(bytes: &[u8]) -> bool {
    std::str::from_utf8(bytes)
        .is_ok_and(|text| STORAGE_NAMES.iter().any(|name| text.contains(name)))
}

/// What the Ship panel and the approval dialog say of a build that may use browser storage (the plan's 5.2.1 and 10).
pub const STORAGE_WARNING_NOTICE: &str =
    "This build may use browser storage, which production apps don't have.";

/// What the approval dialog says of every release made from a preview (the plan's section 10; decision 255).
pub const PREVIEW_DIFFERENCES_NOTICE: &str = "This build ran in the preview with browser storage and its own origin. In production it runs sandboxed, with neither, so anything that worked only because of them will break.";
