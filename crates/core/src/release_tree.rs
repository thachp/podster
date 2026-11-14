//! What a release may contain, decided from GitHub's tree alone before any file is fetched (ADR 0010, the release job).
//! Pure, with no I/O.
//!
//! The job reads the commit's top tree, requires the release directory's entry there to be a directory
//! ([`release_directory`]), reads that entry's own tree recursively, caps each answer's bytes ([`tree_answer_fits`]),
//! and then judges the entries ([`check_release_tree`]). Each fetched file is checked against its entry
//! ([`check_fetched`]). Nothing in the repository configures the job: agent content is data.

use std::collections::BTreeMap;

use icu_normalizer::ComposingNormalizerBorrowed;
use icu_properties::props::GeneralCategory;
use icu_properties::CodePointMapData;

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
    /// `release_path_collision`: two paths served at one address, or a path served at the marker's.
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
    /// A format character (general category Cf, such as a bidi override or a zero-width character), a line or paragraph
    /// separator (Zl, Zp), or any whitespace outside ASCII. Ruled on the review of PR #309: such a path can show as
    /// another, or as nothing.
    Invisible,
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
    let categories = CodePointMapData::<GeneralCategory>::new();
    if path.chars().any(|c| {
        matches!(
            categories.get(c),
            GeneralCategory::Format
                | GeneralCategory::LineSeparator
                | GeneralCategory::ParagraphSeparator
        ) || (!c.is_ascii() && c.is_whitespace())
    }) {
        return Err(PathProblem::Invisible);
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

/// A path as two paths are compared for twins: its compatibility form (NFKC), then lower-cased, upper-cased and
/// lower-cased again. So `ẞ`, `ß` and `ss` are one, as are `A` and `a`, and a ligature and its letters. Ruled on the
/// review of PR #309 as full Unicode case folding after NFKC; Rust's standard library has no case-folding table, so this
/// is the round trip through its case mappings, which puts in one class every pair the folding table does that was
/// tried, and may put a few more together, which only refuses more.
pub fn fold(path: &str) -> String {
    let compatible = ComposingNormalizerBorrowed::new_nfkc().normalize(path);
    compatible.to_lowercase().to_uppercase().to_lowercase()
}

/// The address a file is served at under the platform's default HTML handling, which a release is uploaded with. When
/// two paths are compared it is given the folded path ([`fold`]), so `.HTML` and a full-width `ｈｔｍｌ` are stripped
/// like `.html`:
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
    // The marker's own address is taken before any file's, so nothing in the repository is served where it is.
    let mut addresses: BTreeMap<String, &str> =
        BTreeMap::from([(served_address(&fold(MARKER_PATH)), MARKER_PATH)]);
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
                if let Some(other) = addresses.insert(served_address(&fold(entry.path)), entry.path)
                {
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

// ---------------------------------------------------------------------------------------------------------------------
// Reading a release: what a failed read means, the type a file is served with, and the names the upload uses
// ---------------------------------------------------------------------------------------------------------------------

/// Why reading a release from the repository gave nothing to publish, apart from its contents failing it
/// ([`ContentProblem`]) and a fetched file not matching its entry ([`FetchMismatch`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReadProblem {
    /// `release_read_not_configured`: the deployment has no read-only App to read with. The release waits.
    NotConfigured,
    /// `release_read_unavailable`: the provider gave no answer to go on, a rate limit among them, or a token that
    /// wasn't exactly the one asked for. The release waits, and the read is tried again.
    Unavailable,
    /// `release_commit_unreadable`: the provider answered, and the commit or the directory's tree isn't there to
    /// read. The release fails: the room's own record said this commit was merged, and the repository disagrees.
    CommitUnreadable,
}

impl ReadProblem {
    // codes: reasons
    pub fn code(self) -> &'static str {
        match self {
            ReadProblem::NotConfigured => "release_read_not_configured",
            ReadProblem::Unavailable => "release_read_unavailable",
            ReadProblem::CommitUnreadable => "release_commit_unreadable",
        }
    }

    /// Whether it ends the release. The other two leave it to be tried again.
    pub fn fails_release(self) -> bool {
        self == ReadProblem::CommitUnreadable
    }
}

/// The type a file is served with, from its path's last extension, by Podster's own list. Nothing the repository or
/// the provider says of a file's type is used. A file of a kind not listed is served as bytes to download.
pub fn served_type(path: &str) -> &'static str {
    let name = path.rsplit('/').next().unwrap_or(path);
    let extension = match name.rsplit_once('.') {
        // A name that is only a leading dot and letters, as `.gitkeep`, has no extension.
        Some((stem, extension)) if !stem.is_empty() => extension.to_ascii_lowercase(),
        _ => String::new(),
    };
    match extension.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" | "map" => "application/json",
        "webmanifest" => "application/manifest+json",
        "txt" => "text/plain; charset=utf-8",
        "xml" => "application/xml",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "wasm" => "application/wasm",
        "pdf" => "application/pdf",
        "mp3" => "audio/mpeg",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        _ => "application/octet-stream",
    }
}

/// What goes before a file's bytes in its manifest hash: the type it is served with, then one zero byte. The hash is
/// the first 32 hexadecimal characters of a SHA-256 over this and then **the file's own bytes** ([`manifest_hash`]).
///
/// The hash comes back to visitors as the file's `ETag`, so it must change whenever what is served changes: the
/// bytes, or the type. **It is never taken over git's blob sha:** whatever the provider keeps by this hash then rests
/// on SHA-256 over the bytes alone, and never on SHA-1. No type holds a zero byte, so no type and bytes run together
/// into another pair's.
pub fn manifest_hash_prefix(served_type: &str) -> Vec<u8> {
    let mut prefix = served_type.as_bytes().to_vec();
    prefix.push(0);
    prefix
}

/// The manifest's hash for a file: the first 32 hexadecimal characters, in lower case, of the SHA-256 the caller took
/// over [`manifest_hash_prefix`] and then the file's bytes. `None` if what it is given isn't a SHA-256's 64
/// hexadecimal characters.
pub fn manifest_hash(sha256_hex: &str) -> Option<String> {
    (sha256_hex.len() == 64 && sha256_hex.bytes().all(|b| b.is_ascii_hexdigit()))
        .then(|| sha256_hex[..32].to_ascii_lowercase())
}

/// The type the job's own marker file is served with.
pub const MARKER_TYPE: &str = "application/json";

/// What the job's own marker file holds, at [`MARKER_PATH`]: the release's ID and its commit, and nothing else.
/// Fetching it through a host says which release that host is serving. `None` unless both are exactly the form
/// Podster made them in, so nothing else is ever written into the file.
pub fn marker_body(release_id: &str, commit_sha: &str) -> Option<String> {
    (crate::release::is_release_id(release_id) && crate::repositories::valid_commit_sha(commit_sha))
        .then(|| format!("{{\"release_id\":\"{release_id}\",\"commit\":\"{commit_sha}\"}}\n"))
}

/// The header git puts before a file's bytes when it names them: a blob's sha is the SHA-1 of this and then the bytes.
pub fn git_blob_header(length: u64) -> Vec<u8> {
    format!("blob {length}\0").into_bytes()
}
