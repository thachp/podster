//! What a release may contain, decided from GitHub's tree alone before any file is fetched (ADR 0010, the release job).
//! Pure, with no I/O.
//!
//! The job reads the commit's top tree, requires the release directory's entry there to be a directory
//! ([`release_directory`]), reads that entry's own tree recursively, caps each answer's bytes ([`tree_answer_fits`]),
//! and then judges the entries ([`check_release_tree`]). Each fetched file is checked against its entry
//! ([`check_fetched`]). Nothing in the repository configures the job: agent content is data.

use std::collections::BTreeMap;

use icu_normalizer::ComposingNormalizerBorrowed;

/// The fixed name of the release directory, the same in every room. A room can't choose it.
pub const RELEASE_DIRECTORY: &str = "site";
/// The marker the job adds to every release, at this path under the directory. A repository can't supply it.
pub const MARKER_PATH: &str = ".well-known/podster-release.json";
/// Files in a release.
pub const MAX_FILES: usize = 300;
/// Entries of every kind in the directory's tree, directories and empty ones included.
pub const MAX_TREE_ENTRIES: usize = 1_000;
/// Bytes of either tree answer, before it is parsed.
pub const MAX_TREE_ANSWER_BYTES: u64 = 1_000_000;
/// One file.
pub const MAX_FILE_BYTES: u64 = 5_000_000;
/// The whole release.
pub const MAX_RELEASE_BYTES: u64 = 25_000_000;
/// A path, in bytes.
pub const MAX_PATH_BYTES: usize = 1_024;
/// One segment of a path, in bytes.
pub const MAX_SEGMENT_BYTES: usize = 255;
/// Names refused anywhere in the directory: the platform treats them specially.
pub const REFUSED_NAMES: [&str; 4] = ["_headers", "_redirects", "_worker.js", "_routes.json"];

/// A tree entry's kind, from its `type`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EntryKind {
    Blob,
    Tree,
    Commit,
    Other,
}

impl EntryKind {
    pub fn parse(kind: &str) -> EntryKind {
        match kind {
            "blob" => EntryKind::Blob,
            "tree" => EntryKind::Tree,
            "commit" => EntryKind::Commit,
            _ => EntryKind::Other,
        }
    }
}

/// One entry of GitHub's tree, as the job parsed it. `path` is relative to the release directory.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TreeEntry<'a> {
    pub path: &'a str,
    pub mode: &'a str,
    pub kind: EntryKind,
    pub size: Option<u64>,
    pub sha: &'a str,
}

/// Why a release's contents fail it. Every one fails the whole release: the job never publishes part of a directory.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ContentProblem {
    /// `release_directory_missing`: the commit's top tree has no entry of that name.
    DirectoryMissing,
    /// `release_directory_not_a_directory`: the entry is there and isn't `mode 040000`, `type tree`.
    DirectoryNotTree,
    /// `release_tree_too_large`: a tree answer over 1 MB, more than 1,000 entries, or marked `truncated`.
    TreeTooLarge,
    /// `release_empty`: no file to serve.
    Empty,
    /// `release_too_many_files`
    TooManyFiles(usize),
    /// `release_too_large`: over 25 MB in all.
    TooLarge(u64),
    /// `release_file_too_large`: one file over 5 MB.
    FileTooLarge(String),
    /// `release_file_without_size`: a file's entry carries no size.
    FileWithoutSize(String),
    /// `release_symlink`: mode `120000`.
    Symlink(String),
    /// `release_submodule`: mode `160000` or `type commit`.
    Submodule(String),
    /// `release_entry_kind`: any other mode or type.
    UnknownEntry(String),
    /// `release_refused_name`: `_headers`, `_redirects`, `_worker.js`, `_routes.json`, or the marker's path.
    RefusedName(String),
    /// `release_bad_path`: a path that breaks the path rule.
    BadPath(String, PathProblem),
    /// `release_path_collision`: two paths the same after case folding.
    CaseTwins(String, String),
    /// `release_path_collision`: two paths served at one address.
    SameAddress(String, String),
}

impl ContentProblem {
    // codes: reasons
    pub fn code(&self) -> &'static str {
        match self {
            ContentProblem::DirectoryMissing => "release_directory_missing",
            ContentProblem::DirectoryNotTree => "release_directory_not_a_directory",
            ContentProblem::TreeTooLarge => "release_tree_too_large",
            ContentProblem::Empty => "release_empty",
            ContentProblem::TooManyFiles(_) => "release_too_many_files",
            ContentProblem::TooLarge(_) => "release_too_large",
            ContentProblem::FileTooLarge(_) => "release_file_too_large",
            ContentProblem::FileWithoutSize(_) => "release_file_without_size",
            ContentProblem::Symlink(_) => "release_symlink",
            ContentProblem::Submodule(_) => "release_submodule",
            ContentProblem::UnknownEntry(_) => "release_entry_kind",
            ContentProblem::RefusedName(_) => "release_refused_name",
            ContentProblem::BadPath(..) => "release_bad_path",
            ContentProblem::CaseTwins(..) | ContentProblem::SameAddress(..) => {
                "release_path_collision"
            }
        }
    }
}

/// Which part of the path rule a path breaks.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PathProblem {
    TooLong,
    SegmentTooLong,
    EmptySegment,
    DotSegment,
    ControlCharacter,
    Backslash,
    ReplacementCharacter,
    NotNfc,
    EdgeSpace,
}

/// The release directory's entry in the commit's top tree, which must be a directory: its sha is then read recursively.
/// Never `{commit}:{path}`, which follows a submodule entry to another commit's tree.
pub fn release_directory<'a>(top: &[TreeEntry<'a>]) -> Result<&'a str, ContentProblem> {
    let entry = top
        .iter()
        .find(|e| e.path == RELEASE_DIRECTORY)
        .ok_or(ContentProblem::DirectoryMissing)?;
    if entry.mode == "040000" && entry.kind == EntryKind::Tree {
        Ok(entry.sha)
    } else {
        Err(ContentProblem::DirectoryNotTree)
    }
}

/// Whether a tree answer may be parsed: at most 1 MB of bytes, for either of the two reads. Checked before parsing.
pub fn tree_answer_fits(bytes: u64) -> Result<(), ContentProblem> {
    if bytes <= MAX_TREE_ANSWER_BYTES {
        Ok(())
    } else {
        Err(ContentProblem::TreeTooLarge)
    }
}

/// The path rule, for one path relative to the release directory.
pub fn check_path(path: &str) -> Result<(), PathProblem> {
    if path.len() > MAX_PATH_BYTES {
        return Err(PathProblem::TooLong);
    }
    for segment in path.split('/') {
        if segment.is_empty() {
            return Err(PathProblem::EmptySegment);
        }
        if segment.len() > MAX_SEGMENT_BYTES {
            return Err(PathProblem::SegmentTooLong);
        }
        if segment == "." || segment == ".." {
            return Err(PathProblem::DotSegment);
        }
        if segment.starts_with(char::is_whitespace) || segment.ends_with(char::is_whitespace) {
            return Err(PathProblem::EdgeSpace);
        }
    }
    if path.chars().any(char::is_control) {
        return Err(PathProblem::ControlCharacter);
    }
    if path.contains('\\') {
        return Err(PathProblem::Backslash);
    }
    if path.contains('\u{FFFD}') {
        return Err(PathProblem::ReplacementCharacter);
    }
    if !ComposingNormalizerBorrowed::new_nfc().is_normalized(path) {
        return Err(PathProblem::NotNfc);
    }
    Ok(())
}

/// A path case-folded for comparison: upper-cased then lower-cased, which folds `ß` with `ss` as well as `A` with `a`.
pub fn fold(path: &str) -> String {
    path.to_uppercase().to_lowercase()
}

/// The address a file is served at under the platform's default HTML handling, which a release is uploaded with:
/// `x/index.html` at `x/` (the root's at `/`), `x.html` at `x`, and anything else at its own path. Seen in spike A:
/// `/index.html` answered 307 to `/`, and `page.html` was served at `/page`.
pub fn served_address(path: &str) -> String {
    if path == "index.html" {
        return String::new();
    }
    if let Some(dir) = path.strip_suffix("/index.html") {
        return dir.to_owned();
    }
    if let Some(stem) = path.strip_suffix(".html") {
        if !stem.is_empty() && !stem.ends_with('/') {
            return stem.to_owned();
        }
    }
    path.to_owned()
}

/// Whether a path is refused by name: one of [`REFUSED_NAMES`] as any segment, or the marker's path or anything under
/// it. Compared case-folded, so a case twin of a refused name is refused too.
pub fn refused_name(path: &str) -> bool {
    let folded = fold(path);
    let marker = fold(MARKER_PATH);
    folded == marker
        || folded.starts_with(&format!("{marker}/"))
        || folded
            .split('/')
            .any(|segment| REFUSED_NAMES.contains(&segment))
}

/// One file the job will fetch and upload.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlannedFile {
    pub path: String,
    pub size: u64,
    pub sha: String,
}

/// What the tree allows: the files, in path order, and their total size.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReleasePlan {
    pub files: Vec<PlannedFile>,
    pub total_bytes: u64,
}

/// Judges the release directory's recursive tree. `truncated` is GitHub's flag on that answer. Every problem is
/// returned, in the order found; any one fails the release.
pub fn check_release_tree(
    entries: &[TreeEntry],
    truncated: bool,
) -> Result<ReleasePlan, Vec<ContentProblem>> {
    if truncated || entries.len() > MAX_TREE_ENTRIES {
        return Err(vec![ContentProblem::TreeTooLarge]);
    }
    let mut problems = Vec::new();
    let mut files = Vec::new();
    let mut folded: BTreeMap<String, &str> = BTreeMap::new();
    let mut addresses: BTreeMap<String, &str> = BTreeMap::new();
    for entry in entries {
        let path = entry.path.to_owned();
        if let Err(problem) = check_path(entry.path) {
            problems.push(ContentProblem::BadPath(path, problem));
            continue;
        }
        if refused_name(entry.path) {
            problems.push(ContentProblem::RefusedName(path.clone()));
        }
        if let Some(twin) = folded.insert(fold(entry.path), entry.path) {
            problems.push(ContentProblem::CaseTwins(twin.to_owned(), path.clone()));
        }
        match (entry.mode, entry.kind) {
            ("100644" | "100755", EntryKind::Blob) => {
                let Some(size) = entry.size else {
                    problems.push(ContentProblem::FileWithoutSize(path));
                    continue;
                };
                if size > MAX_FILE_BYTES {
                    problems.push(ContentProblem::FileTooLarge(path.clone()));
                }
                if let Some(other) = addresses.insert(served_address(entry.path), entry.path) {
                    problems.push(ContentProblem::SameAddress(other.to_owned(), path.clone()));
                }
                files.push(PlannedFile {
                    path,
                    size,
                    sha: entry.sha.to_owned(),
                });
            }
            ("040000", EntryKind::Tree) => {}
            ("120000", _) => problems.push(ContentProblem::Symlink(path)),
            ("160000", _) | (_, EntryKind::Commit) => {
                problems.push(ContentProblem::Submodule(path))
            }
            _ => problems.push(ContentProblem::UnknownEntry(path)),
        }
    }
    let total_bytes = files.iter().map(|f| f.size).fold(0u64, u64::saturating_add);
    if files.is_empty() && problems.is_empty() {
        problems.push(ContentProblem::Empty);
    }
    if files.len() > MAX_FILES {
        problems.push(ContentProblem::TooManyFiles(files.len()));
    }
    if total_bytes > MAX_RELEASE_BYTES {
        problems.push(ContentProblem::TooLarge(total_bytes));
    }
    if !problems.is_empty() {
        return Err(problems);
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(ReleasePlan { files, total_bytes })
}

/// Why a fetched file doesn't match its tree entry.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FetchMismatch {
    /// `release_file_mismatch`
    Size,
    /// `release_file_mismatch`
    Sha,
}

impl FetchMismatch {
    // codes: reasons
    pub fn code(self) -> &'static str {
        "release_file_mismatch"
    }
}

/// A fetched file against its entry: its length against the tree's size, and its git blob sha, which the caller
/// computed from the bytes, against the tree's sha. GitHub's `Content-Type` is never consulted.
pub fn check_fetched(
    planned: &PlannedFile,
    length: u64,
    blob_sha: &str,
) -> Result<(), FetchMismatch> {
    if length != planned.size {
        return Err(FetchMismatch::Size);
    }
    if !blob_sha.eq_ignore_ascii_case(&planned.sha) {
        return Err(FetchMismatch::Sha);
    }
    Ok(())
}
