//! What a release that carries code may hold (ADR 0010's proposed revision, stage 1, decided by the owner on
//! 2026-11-13 as decision 220). Pure, with no I/O, and not wired into the release job or the content Worker yet.
//!
//! A release carries code when the release directory holds the manifest ([`MANIFEST_PATH`]) at its root, or anything
//! under the modules directory ([`MODULES_DIRECTORY`]). Then:
//!
//! - every file under the modules directory is a **module**, uploaded as the Worker's script and never served as a
//!   file; every other file, the manifest apart, is a **static file**, served as today;
//! - the manifest is agent content, so it is data: Podster reads two fields from it, `main` and `store`, checks them
//!   against the tree, and refuses anything else it holds ([`parse_manifest`]);
//! - nothing in the repository becomes configuration: no `wrangler` file, no binding, no compatibility date or flag.
//!   Podster writes the script's metadata itself, all of it.
//!
//! Built files are committed to the repository; Podster builds nothing (decision 220, answer 3). So a module is a
//! JavaScript module as committed, and nothing else is one in stage 1.
//!
//! The order the job would call these in: [`crate::release_tree::check_release_tree`] judges the tree as for any
//! release; [`split_release`] says whether it carries code and which files are which, from the tree alone, before any
//! file is fetched; the manifest is fetched and given to [`check_code_release`], which reads it and checks its entry
//! module is one of the modules.

use std::collections::BTreeSet;

use crate::release_tree::{fold, PlannedFile, ReleasePlan, MAX_FILE_BYTES};

/// The manifest's path, at the release directory's root. **Proposed:** the revision says "a manifest of a fixed name"
/// and names none.
pub const MANIFEST_PATH: &str = "podster-app.json";
/// The directory, under the release directory, whose every file is a module. **Proposed:** the revision says which
/// files are modules is core's to rule and doesn't say how; a directory of their own keeps a page's own scripts, which
/// are static files, apart from the Worker's.
pub const MODULES_DIRECTORY: &str = "worker";
/// The manifest's size, in bytes. It holds two short fields. **Proposed.**
pub const MAX_MANIFEST_BYTES: u64 = 1_024;
/// Modules in one release. **Proposed.**
pub const MAX_MODULES: usize = 50;
/// One module, in bytes: the same as any file of a release ([`MAX_FILE_BYTES`]).
pub const MAX_MODULE_BYTES: u64 = MAX_FILE_BYTES;
/// All of a release's modules together, in bytes. **Proposed:** well under the platform's 64 MiB for a Worker,
/// uncompressed, and inside the release's own 25 MB.
pub const MAX_MODULES_BYTES: u64 = 10_000_000;
/// The extensions a module may have. JavaScript modules only: whether a namespace takes Python or Wasm modules was not
/// found (the revision, section 4).
pub const MODULE_EXTENSIONS: [&str; 2] = [".js", ".mjs"];
/// The type every module is uploaded with, from Cloudflare's multipart upload metadata documentation.
pub const MODULE_UPLOAD_TYPE: &str = "application/javascript+module";
/// The one name the app's store is bound under, the same in every app. **Proposed:** the revision says "one fixed
/// binding name" and names none. The store's kind waits for the spike.
pub const STORE_BINDING_NAME: &str = "STORE";
/// The manifest's fields, and the only ones. Each must be present.
pub const MANIFEST_FIELDS: [&str; 2] = ["main", "store"];
/// Files refused anywhere in a release that carries code, compared case-folded: each is Wrangler's configuration, and
/// configuration is Podster's to write.
pub const CONFIG_FILE_NAMES: [&str; 3] = ["wrangler.toml", "wrangler.json", "wrangler.jsonc"];
/// Manifest keys that are a Worker's configuration under Wrangler's or the upload's own names. Any key but
/// [`MANIFEST_FIELDS`] is refused; these are refused under their own code, so an author is told plainly that
/// configuration isn't theirs to give.
pub const CONFIG_KEYS: [&str; 24] = [
    "account_id",
    "assets",
    "bindings",
    "compatibility_date",
    "compatibility_flags",
    "d1_databases",
    "durable_objects",
    "env",
    "kv_namespaces",
    "limits",
    "main_module",
    "migrations",
    "name",
    "observability",
    "placement",
    "queues",
    "r2_buckets",
    "route",
    "routes",
    "secrets",
    "services",
    "tail_consumers",
    "triggers",
    "vars",
];

/// Why a release that carries code fails. Every one fails the whole release.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CodeProblem {
    /// `release_manifest_too_large`: the manifest's entry or bytes are over [`MAX_MANIFEST_BYTES`].
    ManifestTooLarge(u64),
    /// `release_manifest_name`: a path that folds to the manifest's and isn't exactly it, or a path under it.
    ManifestName(String),
    /// `release_manifest_missing`: modules, and no manifest.
    ManifestMissing,
    /// `release_manifest_unreadable`: not a flat JSON object of the form [`parse_manifest`] reads.
    ManifestUnreadable,
    /// `release_manifest_duplicate_key`
    ManifestDuplicateKey(String),
    /// `release_manifest_config`: a key that is a Worker's configuration ([`CONFIG_KEYS`]).
    ManifestConfigKey(String),
    /// `release_manifest_unknown_key`
    ManifestUnknownKey(String),
    /// `release_manifest_value`: a field of the wrong kind.
    ManifestValue(String),
    /// `release_manifest_field_missing`
    ManifestFieldMissing(String),
    /// `release_main_not_a_module`: `main` isn't exactly the name of one of the modules.
    MainNotAModule,
    /// `release_modules_directory_name`: a path whose first segment folds to the modules directory's and isn't
    /// exactly it, or a file of that name.
    ModulesDirectoryName(String),
    /// `release_module_kind`: a file under the modules directory whose extension isn't one of [`MODULE_EXTENSIONS`].
    ModuleKind(String),
    /// `release_module_too_large`
    ModuleTooLarge(String),
    /// `release_too_many_modules`
    TooManyModules(usize),
    /// `release_modules_too_large`
    ModulesTooLarge(u64),
    /// `release_config_file`: a `wrangler` file anywhere in the release.
    ConfigFile(String),
}

impl CodeProblem {
    // codes: reasons
    pub fn code(&self) -> &'static str {
        match self {
            CodeProblem::ManifestTooLarge(_) => "release_manifest_too_large",
            CodeProblem::ManifestName(_) => "release_manifest_name",
            CodeProblem::ManifestMissing => "release_manifest_missing",
            CodeProblem::ManifestUnreadable => "release_manifest_unreadable",
            CodeProblem::ManifestDuplicateKey(_) => "release_manifest_duplicate_key",
            CodeProblem::ManifestConfigKey(_) => "release_manifest_config",
            CodeProblem::ManifestUnknownKey(_) => "release_manifest_unknown_key",
            CodeProblem::ManifestValue(_) => "release_manifest_value",
            CodeProblem::ManifestFieldMissing(_) => "release_manifest_field_missing",
            CodeProblem::MainNotAModule => "release_main_not_a_module",
            CodeProblem::ModulesDirectoryName(_) => "release_modules_directory_name",
            CodeProblem::ModuleKind(_) => "release_module_kind",
            CodeProblem::ModuleTooLarge(_) => "release_module_too_large",
            CodeProblem::TooManyModules(_) => "release_too_many_modules",
            CodeProblem::ModulesTooLarge(_) => "release_modules_too_large",
            CodeProblem::ConfigFile(_) => "release_config_file",
        }
    }
}

/// One module: its name, which is its path under the modules directory and the name it is uploaded under, and its
/// file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Module {
    pub name: String,
    pub file: PlannedFile,
}

/// A release that carries code, from its tree alone: the manifest still to be fetched and read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CodeLayout {
    pub manifest: PlannedFile,
    /// In name order.
    pub modules: Vec<Module>,
    pub modules_bytes: u64,
    /// The files served as files, in path order. Neither a module nor the manifest is ever one of them.
    pub static_files: Vec<PlannedFile>,
}

/// What a release is, from its tree.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReleaseShape {
    /// No manifest and no modules: every file is served, as before stage 1.
    Static,
    Code(CodeLayout),
}

/// A release that carries code, checked whole: its manifest read and its entry module found.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CodeRelease {
    /// The entry module's name, one of `modules`.
    pub main: String,
    /// Whether the app asks for its one store.
    pub wants_store: bool,
    pub modules: Vec<Module>,
    pub static_files: Vec<PlannedFile>,
}

fn under_modules_directory(path: &str) -> Option<&str> {
    path.strip_prefix(MODULES_DIRECTORY)
        .and_then(|rest| rest.strip_prefix('/'))
}

fn is_config_file(path: &str) -> bool {
    let folded = fold(path);
    let name = folded.rsplit('/').next().unwrap_or(&folded);
    CONFIG_FILE_NAMES.contains(&name)
}

/// Whether a release carries code, and which of its files are modules, the manifest and static files. From the tree
/// alone; the plan is one [`crate::release_tree::check_release_tree`] already allowed. Every problem is returned, in
/// the order found.
pub fn split_release(plan: &ReleasePlan) -> Result<ReleaseShape, Vec<CodeProblem>> {
    let mut problems = Vec::new();
    let manifest_folded = fold(MANIFEST_PATH);
    let modules_folded = fold(MODULES_DIRECTORY);
    let mut manifest = None;
    let mut modules = Vec::new();
    let mut static_files = Vec::new();
    let mut carries_code = false;
    for file in &plan.files {
        let folded = fold(&file.path);
        if file.path == MANIFEST_PATH {
            carries_code = true;
            if file.size > MAX_MANIFEST_BYTES {
                problems.push(CodeProblem::ManifestTooLarge(file.size));
            }
            manifest = Some(file.clone());
            continue;
        }
        if folded == manifest_folded || folded.starts_with(&format!("{manifest_folded}/")) {
            carries_code = true;
            problems.push(CodeProblem::ManifestName(file.path.clone()));
            continue;
        }
        if let Some(name) = under_modules_directory(&file.path) {
            carries_code = true;
            if !MODULE_EXTENSIONS.iter().any(|ext| {
                name.rsplit('/')
                    .next()
                    .is_some_and(|base| base.len() > ext.len() && base.ends_with(ext))
            }) {
                problems.push(CodeProblem::ModuleKind(file.path.clone()));
            }
            if file.size > MAX_MODULE_BYTES {
                problems.push(CodeProblem::ModuleTooLarge(file.path.clone()));
            }
            modules.push(Module {
                name: name.to_owned(),
                file: file.clone(),
            });
            continue;
        }
        if folded.split('/').next() == Some(modules_folded.as_str()) {
            carries_code = true;
            problems.push(CodeProblem::ModulesDirectoryName(file.path.clone()));
            continue;
        }
        static_files.push(file.clone());
    }
    if !carries_code {
        return Ok(ReleaseShape::Static);
    }
    for file in &static_files {
        if is_config_file(&file.path) {
            problems.push(CodeProblem::ConfigFile(file.path.clone()));
        }
    }
    for module in &modules {
        if is_config_file(&module.file.path) {
            problems.push(CodeProblem::ConfigFile(module.file.path.clone()));
        }
    }
    if manifest.is_none()
        && !problems
            .iter()
            .any(|p| matches!(p, CodeProblem::ManifestName(_)))
    {
        problems.push(CodeProblem::ManifestMissing);
    }
    if modules.len() > MAX_MODULES {
        problems.push(CodeProblem::TooManyModules(modules.len()));
    }
    let modules_bytes = modules
        .iter()
        .map(|m| m.file.size)
        .fold(0u64, u64::saturating_add);
    if modules_bytes > MAX_MODULES_BYTES {
        problems.push(CodeProblem::ModulesTooLarge(modules_bytes));
    }
    if !problems.is_empty() {
        return Err(problems);
    }
    let Some(manifest) = manifest else {
        return Err(vec![CodeProblem::ManifestMissing]);
    };
    modules.sort_by(|a, b| a.name.cmp(&b.name));
    static_files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(ReleaseShape::Code(CodeLayout {
        manifest,
        modules,
        modules_bytes,
        static_files,
    }))
}

/// The two fields Podster reads from a manifest.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Manifest {
    pub main: String,
    pub store: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Value {
    Text(String),
    Bool(bool),
    Other,
}

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl Reader<'_> {
    fn space(&mut self) {
        while self
            .bytes
            .get(self.at)
            .is_some_and(|b| matches!(b, b' ' | b'\t' | b'\n' | b'\r'))
        {
            self.at += 1;
        }
    }

    fn take(&mut self, byte: u8) -> bool {
        if self.bytes.get(self.at) == Some(&byte) {
            self.at += 1;
            true
        } else {
            false
        }
    }

    fn word(&mut self, word: &[u8]) -> bool {
        if self
            .bytes
            .get(self.at..)
            .is_some_and(|rest| rest.starts_with(word))
        {
            self.at += word.len();
            true
        } else {
            false
        }
    }

    /// A string with no escape and no control character. Paths need neither, and refusing escapes means a key or a
    /// value is exactly the bytes between its quotes, whatever parser an author had in mind.
    fn text(&mut self) -> Option<String> {
        if !self.take(b'"') {
            return None;
        }
        let start = self.at;
        loop {
            match self.bytes.get(self.at)? {
                b'"' => break,
                b'\\' => return None,
                b if *b < 0x20 => return None,
                _ => self.at += 1,
            }
        }
        let text = std::str::from_utf8(self.bytes.get(start..self.at)?).ok()?;
        self.at += 1;
        Some(text.to_owned())
    }

    /// A value: a string or a boolean is read; a number, `null`, an object or an array is skipped over as `Other`, so
    /// that the field it belongs to can be named in the refusal. Nesting is refused outright.
    fn value(&mut self) -> Option<Value> {
        match self.bytes.get(self.at)? {
            b'"' => self.text().map(Value::Text),
            b't' => self.word(b"true").then_some(Value::Bool(true)),
            b'f' => self.word(b"false").then_some(Value::Bool(false)),
            b'n' => self.word(b"null").then_some(Value::Other),
            b'-' | b'0'..=b'9' => {
                while self
                    .bytes
                    .get(self.at)
                    .is_some_and(|b| matches!(b, b'-' | b'+' | b'.' | b'e' | b'E' | b'0'..=b'9'))
                {
                    self.at += 1;
                }
                Some(Value::Other)
            }
            open @ (b'{' | b'[') => {
                let close = if *open == b'{' { b'}' } else { b']' };
                self.at += 1;
                self.space();
                // Only an empty object or array is skipped; anything nested in one is not read at all.
                self.take(close).then_some(Value::Other)
            }
            _ => None,
        }
    }
}

/// Reads a manifest's bytes. It must be one flat JSON object, in UTF-8 with no byte-order mark, whose keys are each
/// exactly one of [`MANIFEST_FIELDS`], once: `main`, a string, and `store`, `true` or `false`. No string may hold an
/// escape. Every problem found is returned; a manifest that can't be read as that form is
/// [`CodeProblem::ManifestUnreadable`] alone.
pub fn parse_manifest(bytes: &[u8]) -> Result<Manifest, Vec<CodeProblem>> {
    if bytes.len() as u64 > MAX_MANIFEST_BYTES {
        return Err(vec![CodeProblem::ManifestTooLarge(bytes.len() as u64)]);
    }
    let unreadable = || vec![CodeProblem::ManifestUnreadable];
    let mut reader = Reader { bytes, at: 0 };
    let mut fields: Vec<(String, Value)> = Vec::new();
    reader.space();
    if !reader.take(b'{') {
        return Err(unreadable());
    }
    reader.space();
    if !reader.take(b'}') {
        loop {
            reader.space();
            let key = reader.text().ok_or_else(unreadable)?;
            reader.space();
            if !reader.take(b':') {
                return Err(unreadable());
            }
            reader.space();
            let value = reader.value().ok_or_else(unreadable)?;
            fields.push((key, value));
            reader.space();
            if reader.take(b',') {
                continue;
            }
            if reader.take(b'}') {
                break;
            }
            return Err(unreadable());
        }
    }
    reader.space();
    if reader.at != bytes.len() {
        return Err(unreadable());
    }

    let mut problems = Vec::new();
    let mut seen = BTreeSet::new();
    let mut main = None;
    let mut store = None;
    for (key, value) in fields {
        if !seen.insert(key.clone()) {
            problems.push(CodeProblem::ManifestDuplicateKey(key));
            continue;
        }
        match (key.as_str(), value) {
            ("main", Value::Text(text)) => main = Some(text),
            ("store", Value::Bool(wants)) => store = Some(wants),
            ("main" | "store", _) => problems.push(CodeProblem::ManifestValue(key)),
            (other, _) if CONFIG_KEYS.contains(&other) => {
                problems.push(CodeProblem::ManifestConfigKey(key))
            }
            _ => problems.push(CodeProblem::ManifestUnknownKey(key)),
        }
    }
    for field in MANIFEST_FIELDS {
        if !seen.contains(field) {
            problems.push(CodeProblem::ManifestFieldMissing(field.to_owned()));
        }
    }
    match (main, store, problems.is_empty()) {
        (Some(main), Some(store), true) => Ok(Manifest { main, store }),
        _ => Err(problems),
    }
}

/// A release that carries code, whole: its layout from the tree, and its manifest's bytes as fetched (the caller has
/// checked them against the manifest's entry, as for any file). `main` must be exactly the name of one module: no
/// leading `./`, no folding, nothing resolved.
pub fn check_code_release(
    layout: &CodeLayout,
    manifest_bytes: &[u8],
) -> Result<CodeRelease, Vec<CodeProblem>> {
    let manifest = parse_manifest(manifest_bytes)?;
    if !layout.modules.iter().any(|m| m.name == manifest.main) {
        return Err(vec![CodeProblem::MainNotAModule]);
    }
    Ok(CodeRelease {
        main: manifest.main,
        wants_store: manifest.store,
        modules: layout.modules.clone(),
        static_files: layout.static_files.clone(),
    })
}
