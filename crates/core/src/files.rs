//! The pure part of M2's upload rules: limits, content checks, filename cleaning and the scan states. No I/O.
//!
//! Rules: [upload policy](../../../docs/spec/UPLOAD-POLICY.md). Design: [ADR 0006](../../../docs/adr/0006-uploads-and-scanning.md).
//!
//! Nothing here takes a claimed content type, so a sender's claim can't change an answer. A name can only get a file
//! refused, never accepted.
//!
//! # What checking the bytes can't do
//!
//! Only a sample of the file is read, and these get through:
//!
//! - Scripts. Batch, PowerShell, shell, VBScript and JavaScript are text, and code is on the allowed list.
//! - Text at both ends of a file with anything in the middle.
//! - A file valid as two formats, unless the second is a zip ending the file.
//! - Anything inside an archive: an executable, a nested password-protected archive or a zip bomb.
//! - A password-protected OpenDocument file. It marks encryption in its manifest and leaves the zip flags at 0, so it passes
//!   as an ordinary zip. Refusing all OpenDocument files would close this, and that's the owner's call. The scanner may or
//!   may not flag these.
//! - A DOS program written entirely in printable characters, which reads as text.
//! - A zip whose local header claims encryption where neither sample reaches it, and only there.
//! - A PDF whose last trailer points to an encryption dictionary outside both samples.
//! - Macros other than the Office and OpenDocument paths named in `zip_kind`, and exploits in an allowed format.
//! - An audio-only MP4.
//!
//! The scanner is the next check, and it only recognizes known malware. So none of this makes a file safe.

use std::fmt;

/// 100 MB per file, in decimal so it's under Cloudflare's request limit however that counts a megabyte.
pub const MAX_FILE_BYTES: u64 = 100_000_000;
/// 5 GB per room, counting every version kept.
pub const ROOM_QUOTA_BYTES: u64 = 5_000_000_000;
/// No result within an hour fails the scan.
pub const SCAN_DEADLINE_MS: i64 = 60 * 60 * 1000;
/// Decision 84: signatures older than this can't make a file available.
pub const MAX_SIGNATURE_AGE_MS: i64 = 7 * 24 * 60 * 60 * 1000;
/// How far ahead of the room's clock a signature database's build time may be, for clocks that disagree.
pub const MAX_SIGNATURES_AHEAD_MS: i64 = 24 * 60 * 60 * 1000;
/// The longest scan engine name kept, the scanner's own limit.
pub const MAX_SCAN_ENGINE_BYTES: usize = 40;
/// The longest signature database version kept. It's all digits.
pub const MAX_SCAN_VERSION_BYTES: usize = 20;
/// The longest build time kept, which is an ISO 8601 time with room to spare.
pub const MAX_SCAN_BUILT_AT_BYTES: usize = 40;
/// How much of a file's start `FileSample::head` holds.
pub const SAMPLE_HEAD_BYTES: usize = 64 * 1024;
/// How much of a file's end `FileSample::tail` holds. A zip's directory must fit, which is about 15,000 entries.
pub const SAMPLE_TAIL_BYTES: usize = 1024 * 1024;
/// The longest cleaned name, leaving room for what browsers and file systems add to a 255-byte name.
pub const MAX_FILE_NAME_BYTES: usize = 200;
/// Anything longer isn't a filename, so it isn't worth cleaning.
pub const MAX_RAW_FILE_NAME_BYTES: usize = 4 * 1024;

const MAX_KEPT_EXTENSION_BYTES: usize = 20;

/// Why an upload was refused. It never carries the file's name or bytes, so it's safe to log.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FileRefusal {
    /// `workspace_archived`
    RoomArchived,
    /// `file_too_large`
    TooLarge,
    /// `room_quota_exceeded`
    QuotaExceeded,
    /// `invalid_file_name`
    BadName,
    /// `executable_refused`
    Executable,
    /// `password_protected_refused`
    PasswordProtected,
    /// `macro_file_refused`: refused until the owner rules, as ADR 0006 leaves this open.
    MacroEnabled,
    /// `file_not_inspectable`: the format is one whose bytes can't show the answers these rules need.
    CannotInspect,
    /// `file_type_refused`
    NotOnList,
    /// `upload_mismatch`: what arrived isn't what was announced.
    Mismatch,
    /// `invalid_transition`
    InvalidTransition,
}

impl FileRefusal {
    pub fn code(self) -> &'static str {
        match self {
            FileRefusal::RoomArchived => "workspace_archived",
            FileRefusal::TooLarge => "file_too_large",
            FileRefusal::QuotaExceeded => "room_quota_exceeded",
            FileRefusal::BadName => "invalid_file_name",
            FileRefusal::Executable => "executable_refused",
            FileRefusal::PasswordProtected => "password_protected_refused",
            FileRefusal::MacroEnabled => "macro_file_refused",
            FileRefusal::CannotInspect => "file_not_inspectable",
            FileRefusal::NotOnList => "file_type_refused",
            FileRefusal::Mismatch => "upload_mismatch",
            FileRefusal::InvalidTransition => "invalid_transition",
        }
    }
}

/// A filename that's been through `clean_file_name`. It's agent content, so its `Debug` hides it to keep it out of logs.
#[derive(Clone, PartialEq, Eq)]
pub struct CleanFileName(String);

impl CleanFileName {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for CleanFileName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("CleanFileName(..)")
    }
}

/// Characters that show nothing, or change how the characters around them show: controls, bidi controls, zero-width
/// characters, fillers, variation selectors, tags, private use and noncharacters.
fn is_invisible(c: char) -> bool {
    c.is_control()
        || matches!(
            c,
            '\u{00AD}'
                | '\u{034F}'
                | '\u{061C}'
                | '\u{115F}'
                | '\u{1160}'
                | '\u{17B4}'
                | '\u{17B5}'
                | '\u{180B}'..='\u{180F}'
                | '\u{200B}'..='\u{200F}'
                | '\u{2028}'..='\u{202E}'
                | '\u{2060}'..='\u{206F}'
                | '\u{3164}'
                | '\u{E000}'..='\u{F8FF}'
                | '\u{FDD0}'..='\u{FDEF}'
                | '\u{FE00}'..='\u{FE0F}'
                | '\u{FEFF}'
                | '\u{FFA0}'
                | '\u{FFF0}'..='\u{FFFF}'
                | '\u{1BCA0}'..='\u{1BCA3}'
                | '\u{1D173}'..='\u{1D17A}'
                | '\u{E0000}'..='\u{E0FFF}'
                | '\u{F0000}'..='\u{10FFFF}'
        )
}

fn is_lookalike_separator(c: char) -> bool {
    matches!(
        c,
        '\u{2044}' | '\u{2215}' | '\u{29F8}' | '\u{29F9}' | '\u{FF0F}' | '\u{FF3C}'
    )
}

/// Windows device names, which stay devices with any extension.
fn is_reserved_stem(stem: &str) -> bool {
    let upper = stem.trim_end().to_uppercase();
    if matches!(
        upper.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) {
        return true;
    }
    let number = upper
        .strip_prefix("COM")
        .or_else(|| upper.strip_prefix("LPT"));
    number.is_some_and(|n| {
        let mut chars = n.chars();
        matches!(chars.next(), Some('0'..='9' | '¹' | '²' | '³')) && chars.next().is_none()
    })
}

fn longest_prefix(text: &str, max_bytes: usize) -> &str {
    let mut end = max_bytes.min(text.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text.get(..end).unwrap_or_default()
}

/// Shortens a name, keeping its extension so what's left can't end in a different one.
fn shorten(name: &str) -> String {
    if name.len() <= MAX_FILE_NAME_BYTES {
        return name.to_string();
    }
    let kept = name
        .rsplit_once('.')
        .filter(|(stem, ext)| !stem.is_empty() && ext.len() <= MAX_KEPT_EXTENSION_BYTES);
    match kept {
        Some((stem, ext)) => {
            let room = MAX_FILE_NAME_BYTES - ext.len() - 1;
            format!("{}.{ext}", longest_prefix(stem, room).trim_end())
        }
        None => longest_prefix(name, MAX_FILE_NAME_BYTES).to_string(),
    }
}

/// Makes a hostile name harmless to show and to save: the last path part only, nothing invisible, nothing Windows or a
/// shell treats specially, and short enough for a file system. Refuses when nothing's left. Cleaning a cleaned name
/// changes nothing.
///
/// It doesn't normalize Unicode or replace lookalike letters, so `ехе` in Cyrillic stays as it is. Names aren't identity:
/// objects are keyed by ID. The header carrying a name still has to encode it, in the download step.
pub fn clean_file_name(raw: &str) -> Result<CleanFileName, FileRefusal> {
    if raw.len() > MAX_RAW_FILE_NAME_BYTES {
        return Err(FileRefusal::BadName);
    }
    // Invisible characters go first, so they can't hide a separator or a dot segment from the steps below.
    let visible: String = raw
        .chars()
        .filter(|c| !is_invisible(*c))
        .map(|c| {
            if is_lookalike_separator(c) {
                '/'
            } else if c.is_whitespace() {
                ' '
            } else {
                c
            }
        })
        .collect();
    let last = visible
        .split(['/', '\\'])
        .map(str::trim)
        .rfind(|part| !part.is_empty())
        .ok_or(FileRefusal::BadName)?;
    let mut plain = String::with_capacity(last.len());
    let mut chars = last.chars().peekable();
    while let Some(c) = chars.next() {
        let encodes_something = c == '%' && {
            let mut ahead = chars.clone();
            ahead.next().is_some_and(|d| d.is_ascii_hexdigit())
                && ahead.next().is_some_and(|d| d.is_ascii_hexdigit())
        };
        if encodes_something || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*') {
            plain.push('_');
        } else {
            plain.push(c);
        }
    }
    let spaced = plain.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = spaced.trim_start_matches(['.', ' ', '-', '~']);
    if trimmed.is_empty() {
        return Err(FileRefusal::BadName);
    }
    let stem = trimmed.split('.').next().unwrap_or_default();
    let safe = if is_reserved_stem(stem) {
        format!("_{trimmed}")
    } else {
        trimmed.to_string()
    };
    let short = shorten(&safe);
    let name = short.trim_end_matches(['.', ' ']);
    if name.is_empty() {
        return Err(FileRefusal::BadName);
    }
    Ok(CleanFileName(name.to_string()))
}

/// What a character reads as when it stands in for plain text: full-width forms, and the marks that stand in for a dot. A
/// name isn't stored this way, because these are ordinary characters in a real name. It's only how the name is read below.
fn plain_form(c: char) -> char {
    match c {
        '\u{FF01}'..='\u{FF5E}' => char::from_u32(c as u32 - 0xFEE0).unwrap_or(c),
        '\u{2024}' | '\u{3002}' | '\u{FE52}' | '\u{FF61}' => '.',
        other => other,
    }
}

/// Whether a name would run when someone opens the download, whatever its content. This is the one place a name matters:
/// it can get a file refused, because what the browser saves is what the name says. The list is decision 91 in
/// `docs/spec/PRODUCT.md`, and a name is read through `plain_form`, so one with a full-width dot is refused too.
fn has_refused_extension(name: &CleanFileName) -> bool {
    let plain: String = name.as_str().chars().map(plain_form).collect();
    let Some((_, ext)) = plain.trim_end_matches(['.', ' ']).rsplit_once('.') else {
        return false;
    };
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "exe"
            | "dll"
            | "sys"
            | "msi"
            | "msp"
            | "msix"
            | "msixbundle"
            | "appx"
            | "appxbundle"
            | "com"
            | "scr"
            | "pif"
            | "cpl"
            | "lnk"
            | "hta"
            | "jse"
            | "vbe"
            | "wsf"
            | "wsh"
            | "reg"
            | "jar"
            | "apk"
            | "aab"
            | "ipa"
            | "dmg"
            | "pkg"
            | "deb"
            | "rpm"
            | "appimage"
            | "crx"
            | "xpi"
            | "bin"
            | "elf"
            | "cmd"
            | "vbs"
            | "msc"
            | "inf"
            | "url"
            | "jnlp"
            | "application"
            | "bat"
            | "ps1"
            | "sh"
            | "js"
    )
}

/// What someone asks to upload. There's deliberately no content type: it would only be a claim. Its `Debug` leaves out
/// the name, which hasn't been cleaned.
#[derive(Clone, Copy)]
pub struct UploadRequest<'a> {
    pub name: &'a str,
    pub size: u64,
    /// Space the room has kept and reserved, every version counted.
    pub room_used: u64,
    pub room_archived: bool,
}

impl fmt::Debug for UploadRequest<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("UploadRequest")
            .field("name_bytes", &self.name.len())
            .field("size", &self.size)
            .field("room_used", &self.room_used)
            .field("room_archived", &self.room_archived)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AcceptedUpload {
    pub name: CleanFileName,
    pub size: u64,
}

/// Whether a file fits beside what the room already holds. Asked when an upload starts, and again when one finishes after its
/// reservation has lapsed, because the room may have filled up since.
pub fn fits_room_quota(room_used: u64, size: u64) -> bool {
    room_used
        .checked_add(size)
        .is_some_and(|total| total <= ROOM_QUOTA_BYTES)
}

/// Checks a request before any byte arrives. Who may ask is `podster-policy`'s question, and it runs first.
pub fn check_upload(request: UploadRequest<'_>) -> Result<AcceptedUpload, FileRefusal> {
    if request.room_archived {
        return Err(FileRefusal::RoomArchived);
    }
    if request.size == 0 {
        return Err(FileRefusal::NotOnList);
    }
    if request.size > MAX_FILE_BYTES {
        return Err(FileRefusal::TooLarge);
    }
    if !fits_room_quota(request.room_used, request.size) {
        return Err(FileRefusal::QuotaExceeded);
    }
    let name = clean_file_name(request.name)?;
    if has_refused_extension(&name) {
        return Err(FileRefusal::Executable);
    }
    Ok(AcceptedUpload {
        name,
        size: request.size,
    })
}

/// A file's type, decided from its content. The formats behind each allowed category are **proposed** in ADR 0006, and
/// settled when the storage PR is reviewed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ContentKind {
    Pdf,
    Rtf,
    Word,
    Spreadsheet,
    Presentation,
    Png,
    Jpeg,
    Gif,
    Webp,
    Tiff,
    Bmp,
    Heif,
    Mp4,
    QuickTime,
    Matroska,
    Avi,
    Mpeg,
    /// A zip archive, including OpenDocument files.
    Zip,
    /// UTF-8 text, which includes code, HTML and SVG. It's labeled plain so nothing renders it.
    Text,
}

impl ContentKind {
    /// The type to serve it as, alongside `X-Content-Type-Options: nosniff` and as an attachment.
    pub fn media_type(self) -> &'static str {
        match self {
            ContentKind::Pdf => "application/pdf",
            ContentKind::Rtf => "application/rtf",
            ContentKind::Word => {
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            }
            ContentKind::Spreadsheet => {
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            }
            ContentKind::Presentation => {
                "application/vnd.openxmlformats-officedocument.presentationml.presentation"
            }
            ContentKind::Png => "image/png",
            ContentKind::Jpeg => "image/jpeg",
            ContentKind::Gif => "image/gif",
            ContentKind::Webp => "image/webp",
            ContentKind::Tiff => "image/tiff",
            ContentKind::Bmp => "image/bmp",
            ContentKind::Heif => "image/heif",
            ContentKind::Mp4 => "video/mp4",
            ContentKind::QuickTime => "video/quicktime",
            ContentKind::Matroska => "video/x-matroska",
            ContentKind::Avi => "video/x-msvideo",
            ContentKind::Mpeg => "video/mpeg",
            ContentKind::Zip => "application/zip",
            ContentKind::Text => "text/plain; charset=utf-8",
        }
    }
}

/// Every type `ContentKind::media_type` can give. A stored value that isn't one of these is served as plain bytes.
const SERVED_MEDIA_TYPES: [ContentKind; 19] = [
    ContentKind::Pdf,
    ContentKind::Rtf,
    ContentKind::Word,
    ContentKind::Spreadsheet,
    ContentKind::Presentation,
    ContentKind::Png,
    ContentKind::Jpeg,
    ContentKind::Gif,
    ContentKind::Webp,
    ContentKind::Tiff,
    ContentKind::Bmp,
    ContentKind::Heif,
    ContentKind::Mp4,
    ContentKind::QuickTime,
    ContentKind::Matroska,
    ContentKind::Avi,
    ContentKind::Mpeg,
    ContentKind::Zip,
    ContentKind::Text,
];

/// The `Content-Type` to serve a stored file with. It's only ever a type the upload rules chose from the file's content, so a
/// bad or missing row can't name something a browser would render.
pub fn served_media_type(stored: Option<&str>) -> &'static str {
    SERVED_MEDIA_TYPES
        .iter()
        .map(|kind| kind.media_type())
        .find(|media_type| Some(*media_type) == stored)
        .unwrap_or("application/octet-stream")
}

/// The `Content-Disposition` to serve a file with, always an attachment. A name is agent content, so only characters that can't
/// end the value or start another header get through, whatever the stored name holds. `filename*` carries the real name for
/// clients that read it (RFC 6266), and `filename` is a plain stand-in for those that don't.
pub fn attachment_header(name: &str) -> String {
    let plain: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ' ') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let plain = plain.trim_matches([' ', '.']);
    let plain = if plain.is_empty() { "download" } else { plain };
    let mut encoded = String::with_capacity(name.len());
    for byte in name.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_') {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    format!("attachment; filename=\"{plain}\"; filename*=UTF-8''{encoded}")
}

/// The ends of a file. `head` is its first `SAMPLE_HEAD_BYTES` and `tail` its last `SAMPLE_TAIL_BYTES`, or all of it when
/// it's shorter, and the two can overlap. A sample of any other length is refused. Its `Debug` prints lengths, never bytes.
#[derive(Clone, Copy)]
pub struct FileSample<'a> {
    pub head: &'a [u8],
    pub tail: &'a [u8],
    pub total_size: u64,
}

/// Collects a file's ends as it streams past, for `FileSample`. It holds at most twice the tail's sample, plus one chunk, however
/// large the file is.
#[derive(Clone, Default)]
pub struct FileEnds {
    head: Vec<u8>,
    tail: Vec<u8>,
}

impl FileEnds {
    pub fn add(&mut self, chunk: &[u8]) {
        let room = SAMPLE_HEAD_BYTES.saturating_sub(self.head.len());
        self.head.extend(chunk.iter().take(room));
        self.tail.extend_from_slice(chunk);
        // Only past twice the sample, so most chunks move nothing.
        if self.tail.len() > SAMPLE_TAIL_BYTES * 2 {
            let extra = self.tail.len() - SAMPLE_TAIL_BYTES;
            self.tail.drain(..extra);
        }
    }

    pub fn head(&self) -> &[u8] {
        &self.head
    }

    pub fn tail(&self) -> &[u8] {
        let extra = self.tail.len().saturating_sub(SAMPLE_TAIL_BYTES);
        self.tail.get(extra..).unwrap_or_default()
    }
}

impl fmt::Debug for FileEnds {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("FileEnds")
            .field("head_bytes", &self.head.len())
            .field("tail_bytes", &self.tail.len())
            .finish()
    }
}

impl fmt::Debug for FileSample<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("FileSample")
            .field("head_bytes", &self.head.len())
            .field("tail_bytes", &self.tail.len())
            .field("total_size", &self.total_size)
            .finish()
    }
}

impl FileSample<'_> {
    fn is_whole(&self) -> bool {
        let expected = |limit: usize| self.total_size.min(limit as u64);
        self.head.len() as u64 == expected(SAMPLE_HEAD_BYTES)
            && self.tail.len() as u64 == expected(SAMPLE_TAIL_BYTES)
    }

    fn tail_start(&self) -> u64 {
        self.total_size.saturating_sub(self.tail.len() as u64)
    }
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

fn u16_at(bytes: &[u8], at: usize) -> Option<u16> {
    let raw = bytes.get(at..at.checked_add(2)?)?;
    Some(u16::from_le_bytes(raw.try_into().ok()?))
}

fn u32_at(bytes: &[u8], at: usize) -> Option<u32> {
    let raw = bytes.get(at..at.checked_add(4)?)?;
    Some(u32::from_le_bytes(raw.try_into().ok()?))
}

/// Whether this is a Windows program: `MZ`, then at 0x3C the place of its `PE` header, with the header there. Two letters
/// alone would catch text that starts "MZ".
///
/// A file whose header is out of both samples still can't be accepted. A pointer to anywhere under the size limit has a NUL
/// in its top bytes, so it isn't text, and it matches no other allowed format, so it's refused as not on the list. Only a
/// DOS program written entirely in printable characters gets through as text, and its name can't end `.exe` or `.com`.
fn has_pe_header(sample: &FileSample<'_>) -> bool {
    if !sample.head.starts_with(b"MZ") {
        return false;
    }
    u32_at(sample.head, 0x3C).is_some_and(|at| {
        let at = u64::from(at);
        let in_head = usize::try_from(at)
            .ok()
            .and_then(|at| sample.head.get(at..));
        let in_tail = at
            .checked_sub(sample.tail_start())
            .and_then(|at| usize::try_from(at).ok())
            .and_then(|at| sample.tail.get(at..));
        [in_head, in_tail]
            .into_iter()
            .flatten()
            .any(|found| found.starts_with(b"PE\0\0"))
    })
}

fn is_executable(sample: &FileSample<'_>) -> bool {
    const SIGNATURES: [&[u8]; 15] = [
        b"\x7fELF",                                        // Linux programs
        b"\xFE\xED\xFA\xCE",                               // Mach-O
        b"\xFE\xED\xFA\xCF",                               // Mach-O
        b"\xCE\xFA\xED\xFE",                               // Mach-O
        b"\xCF\xFA\xED\xFE",                               // Mach-O
        b"\xCA\xFE\xBA\xBE",                               // Mach-O universal, and Java classes
        b"\0asm",                                          // WebAssembly
        b"dex\n0",                                         // Android
        b"\xED\xAB\xEE\xDB",                               // RPM
        b"!<arch>",                                        // deb, and static libraries
        b"MSCF",                                           // Windows cabinets
        b"ISc(",                                           // InstallShield
        b"xar!",                                           // macOS installers
        b"Cr24",                                           // Chrome extensions
        b"L\0\0\0\x01\x14\x02\0\0\0\0\0\xC0\0\0\0\0\0\0F", // Windows shortcuts
    ];
    if SIGNATURES.iter().any(|s| sample.head.starts_with(s)) || has_pe_header(sample) {
        return true;
    }
    // A disk image says what it is in its last 512 bytes.
    let from_end = sample.tail.len().checked_sub(512);
    from_end
        .and_then(|at| sample.tail.get(at..))
        .is_some_and(|end| end.starts_with(b"koly"))
}

/// The end-of-central-directory record: its place in `tail`. A record only counts if its comment runs exactly to the end
/// of the file, so a signature inside another record's comment isn't taken for one.
fn find_zip_end(tail: &[u8]) -> Option<usize> {
    const END_RECORD_BYTES: usize = 22;
    let last = tail.len().checked_sub(END_RECORD_BYTES)?;
    (last.saturating_sub(usize::from(u16::MAX))..=last)
        .rev()
        .find(|&at| {
            tail.get(at..)
                .is_some_and(|rest| rest.starts_with(b"PK\x05\x06"))
                && u16_at(tail, at + 20).is_some_and(|comment| {
                    at + END_RECORD_BYTES + usize::from(comment) == tail.len()
                })
        })
}

/// Bit 0 is encryption, bit 6 strong encryption and bit 13 a hidden directory. Method 99 is WinZip's AES.
fn zip_entry_is_encrypted(flags: u16, method: u16) -> bool {
    flags & 0x2041 != 0 || method == 99
}

/// A local header reachable in either sample, if it's there.
fn local_header<'a>(sample: &FileSample<'a>, offset: u64) -> Option<&'a [u8]> {
    if let Some(found) = usize::try_from(offset)
        .ok()
        .and_then(|at| sample.head.get(at..))
    {
        if found.len() >= 30 {
            return Some(found);
        }
    }
    let at = usize::try_from(offset.checked_sub(sample.tail_start())?).ok()?;
    sample.tail.get(at..).filter(|found| found.len() >= 30)
}

/// Reads a zip's whole directory, and refuses if it can't, so an entry can't be hidden from these checks.
///
/// A jar, an Android or iOS app and a Windows app package are zips that install or run, so their fixed entry names make
/// them executables. Macro-enabled Office and OpenDocument files are refused only because ADR 0006 leaves them open.
fn zip_kind(sample: &FileSample<'_>) -> Result<ContentKind, FileRefusal> {
    let first_flags = u16_at(sample.head, 6).ok_or(FileRefusal::CannotInspect)?;
    let first_method = u16_at(sample.head, 8).ok_or(FileRefusal::CannotInspect)?;
    if zip_entry_is_encrypted(first_flags, first_method) {
        return Err(FileRefusal::PasswordProtected);
    }
    let directory = zip_directory(sample).ok_or(FileRefusal::CannotInspect)?;
    let mut has = ZipContents::default();
    let mut at = 0_usize;
    for _ in 0..directory.entries {
        let entry = directory
            .bytes
            .get(at..)
            .ok_or(FileRefusal::CannotInspect)?;
        let read = (|| {
            if !entry.starts_with(b"PK\x01\x02") {
                return None;
            }
            let lengths = [
                usize::from(u16_at(entry, 28)?),
                usize::from(u16_at(entry, 30)?),
                usize::from(u16_at(entry, 32)?),
            ];
            let name = entry.get(46..46 + lengths[0])?;
            Some((
                u16_at(entry, 8)?,
                u16_at(entry, 10)?,
                u64::from(u32_at(entry, 42)?),
                name,
                46 + lengths.iter().sum::<usize>(),
            ))
        })();
        let (flags, method, offset, name, length) = read.ok_or(FileRefusal::CannotInspect)?;
        if zip_entry_is_encrypted(flags, method) {
            return Err(FileRefusal::PasswordProtected);
        }
        if let Some(local) = local_header(sample, offset) {
            let local_flags = u16_at(local, 6).unwrap_or(u16::MAX);
            let local_method = u16_at(local, 8).unwrap_or(u16::MAX);
            if zip_entry_is_encrypted(local_flags, local_method) {
                return Err(FileRefusal::PasswordProtected);
            }
        }
        has.note(
            &String::from_utf8_lossy(name)
                .replace('\\', "/")
                .to_lowercase(),
        );
        at += length;
    }
    if at != directory.bytes.len() {
        return Err(FileRefusal::CannotInspect);
    }
    has.kind()
}

struct ZipDirectory<'a> {
    bytes: &'a [u8],
    entries: u16,
}

/// A zip this can read completely: on one disk, starting at the file's start, with its directory in `tail`. Zip64 is
/// refused without a check of its own: its markers can't pass the position check, and 65,535 entries don't fit in `tail`.
fn zip_directory<'a>(sample: &FileSample<'a>) -> Option<ZipDirectory<'a>> {
    let end_at = find_zip_end(sample.tail)?;
    let end = sample.tail.get(end_at..)?;
    let entries = u16_at(end, 10)?;
    let size = u32_at(end, 12)?;
    let offset = u32_at(end, 16)?;
    let one_disk = u16_at(end, 4)? == 0 && u16_at(end, 6)? == 0 && u16_at(end, 8)? == entries;
    if !one_disk || entries == 0 {
        return None;
    }
    let end_in_file = sample.tail_start() + end_at as u64;
    if u64::from(offset) + u64::from(size) != end_in_file {
        return None;
    }
    let start = usize::try_from(u64::from(offset).checked_sub(sample.tail_start())?).ok()?;
    Some(ZipDirectory {
        bytes: sample.tail.get(start..end_at)?,
        entries,
    })
}

#[derive(Default)]
struct ZipContents {
    runnable: bool,
    content_types: bool,
    word: bool,
    sheet: bool,
    slides: bool,
    office_macros: bool,
    open_document: [bool; 2],
    open_document_macros: bool,
}

impl ZipContents {
    fn note(&mut self, name: &str) {
        self.runnable |= matches!(
            name,
            "meta-inf/manifest.mf"
                | "androidmanifest.xml"
                | "classes.dex"
                | "appxmanifest.xml"
                | "appxmetadata/appxbundlemanifest.xml"
        ) || (name.starts_with("payload/") && name.contains(".app/"));
        self.content_types |= name == "[content_types].xml";
        self.word |= name.starts_with("word/");
        self.sheet |= name.starts_with("xl/");
        self.slides |= name.starts_with("ppt/");
        self.office_macros |=
            name.ends_with("/vbaproject.bin") || name.starts_with("xl/macrosheets/");
        self.open_document[0] |= name == "mimetype";
        self.open_document[1] |= name == "meta-inf/manifest.xml";
        self.open_document_macros |= name.starts_with("basic/") || name.starts_with("scripts/");
    }

    fn kind(&self) -> Result<ContentKind, FileRefusal> {
        if self.runnable {
            return Err(FileRefusal::Executable);
        }
        let open_document = self.open_document == [true, true];
        if (self.content_types && self.office_macros)
            || (open_document && self.open_document_macros)
        {
            return Err(FileRefusal::MacroEnabled);
        }
        Ok(
            match (self.content_types, self.word, self.sheet, self.slides) {
                (true, true, _, _) => ContentKind::Word,
                (true, _, true, _) => ContentKind::Spreadsheet,
                (true, _, _, true) => ContentKind::Presentation,
                _ => ContentKind::Zip,
            },
        )
    }
}

/// Whether these bytes name `/Encrypt` as a PDF name, including written with `#xx` escapes as PDF allows.
fn names_pdf_encryption(bytes: &[u8]) -> bool {
    bytes.iter().enumerate().any(|(at, byte)| {
        if *byte != b'/' {
            return false;
        }
        let mut wanted = b"Encrypt".iter();
        let mut rest = bytes.get(at + 1..).unwrap_or_default().iter();
        let mut next_wanted = wanted.next();
        while let Some(expected) = next_wanted {
            let got = match rest.next() {
                Some(b'#') => {
                    let high = rest.next().and_then(|d| (*d as char).to_digit(16));
                    let low = rest.next().and_then(|d| (*d as char).to_digit(16));
                    match (high, low) {
                        (Some(high), Some(low)) => (high * 16 + low) as u8,
                        _ => return false,
                    }
                }
                Some(other) => *other,
                None => return false,
            };
            if got != *expected {
                return false;
            }
            next_wanted = wanted.next();
        }
        true
    })
}

/// Any `/Encrypt` refuses a PDF. That includes one with only an owner password, which opens and scans fine. Whether those
/// should pass is open.
fn pdf_kind(sample: &FileSample<'_>) -> Result<ContentKind, FileRefusal> {
    if names_pdf_encryption(sample.head) || names_pdf_encryption(sample.tail) {
        return Err(FileRefusal::PasswordProtected);
    }
    // The last trailer is what a reader follows. Padding that pushes it out of the sample would hide its `/Encrypt`.
    if !contains(sample.tail, b"startxref") {
        return Err(FileRefusal::CannotInspect);
    }
    Ok(ContentKind::Pdf)
}

/// Legacy Office files and Windows Installer packages share one container. Bytes alone can't reliably say which it is,
/// whether it has macros or, for the older formats, a password, so only the modern encrypted form gets its own answer.
fn compound_file_refusal(sample: &FileSample<'_>) -> FileRefusal {
    let marker: Vec<u8> = "EncryptedPackage"
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect();
    if contains(sample.head, &marker) || contains(sample.tail, &marker) {
        FileRefusal::PasswordProtected
    } else {
        FileRefusal::CannotInspect
    }
}

fn image_or_video(sample: &FileSample<'_>) -> Option<ContentKind> {
    let head = sample.head;
    if head.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some(ContentKind::Png);
    }
    if head.starts_with(b"\xFF\xD8\xFF") {
        return Some(ContentKind::Jpeg);
    }
    if head.starts_with(b"GIF87a") || head.starts_with(b"GIF89a") {
        return Some(ContentKind::Gif);
    }
    if head.starts_with(b"II*\0") || head.starts_with(b"MM\0*") {
        return Some(ContentKind::Tiff);
    }
    // Two letters alone would catch text that starts "BM", so its stated size has to match too.
    if head.starts_with(b"BM") && u32_at(head, 2).map(u64::from) == Some(sample.total_size) {
        return Some(ContentKind::Bmp);
    }
    if head.starts_with(b"\x1A\x45\xDF\xA3") {
        return Some(ContentKind::Matroska);
    }
    if head.starts_with(b"\0\0\x01\xBA") || head.starts_with(b"\0\0\x01\xB3") {
        return Some(ContentKind::Mpeg);
    }
    if head.starts_with(b"RIFF") {
        return match head.get(8..12)? {
            b"WEBP" => Some(ContentKind::Webp),
            b"AVI " => Some(ContentKind::Avi),
            _ => None,
        };
    }
    if head.get(4..8)? == b"ftyp" {
        return match head.get(8..12)? {
            b"heic" | b"heix" | b"hevc" | b"mif1" | b"msf1" | b"avif" => Some(ContentKind::Heif),
            b"qt  " => Some(ContentKind::QuickTime),
            b"isom" | b"iso2" | b"iso4" | b"iso5" | b"iso6" | b"mp41" | b"mp42" | b"avc1"
            | b"M4V " | b"M4VP" | b"3gp4" | b"3gp5" | b"3gp6" | b"3g2a" | b"dash" => {
                Some(ContentKind::Mp4)
            }
            _ => None,
        };
    }
    None
}

/// UTF-8 with no NUL and no control characters a text file wouldn't have. A sample cut from a longer file may start or end
/// partway through a character.
fn is_text(bytes: &[u8], cut_at_start: bool, cut_at_end: bool) -> bool {
    let continuation = |b: &u8| b & 0xC0 == 0x80;
    let skip = if cut_at_start {
        bytes.iter().take(3).take_while(|b| continuation(b)).count()
    } else {
        0
    };
    let bytes = bytes.get(skip..).unwrap_or_default();
    let text = match std::str::from_utf8(bytes) {
        Ok(text) => text,
        Err(error) if cut_at_end && error.error_len().is_none() => bytes
            .get(..error.valid_up_to())
            .and_then(|valid| std::str::from_utf8(valid).ok())
            .unwrap_or_default(),
        Err(_) => return false,
    };
    !text
        .chars()
        .any(|c| c.is_control() && !matches!(c, '\t' | '\n' | '\r' | '\x0C' | '\x1B'))
}

/// Decides what a file is from its bytes, or refuses it. Denies by default: a file has to match an allowed format, so the
/// executable signatures only make the refusal more exact. See the module's notes for what this can't detect.
pub fn classify(sample: &FileSample<'_>) -> Result<ContentKind, FileRefusal> {
    if !sample.is_whole() {
        return Err(FileRefusal::CannotInspect);
    }
    if sample.total_size == 0 {
        return Err(FileRefusal::NotOnList);
    }
    if is_executable(sample) {
        return Err(FileRefusal::Executable);
    }
    if sample.head.starts_with(b"\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1") {
        return Err(compound_file_refusal(sample));
    }
    if sample.head.starts_with(b"PK\x03\x04") {
        return zip_kind(sample);
    }
    // A zip stuck on the end of something else would carry files nothing here looked at.
    if find_zip_end(sample.tail).is_some() {
        return Err(FileRefusal::CannotInspect);
    }
    if sample.head.starts_with(b"%PDF-") {
        return pdf_kind(sample);
    }
    if sample.head.starts_with(b"{\\rtf") {
        return Ok(ContentKind::Rtf);
    }
    if let Some(kind) = image_or_video(sample) {
        return Ok(kind);
    }
    let cut = sample.total_size > sample.head.len() as u64;
    let tail_cut = sample.total_size > sample.tail.len() as u64;
    if is_text(sample.head, false, cut) && is_text(sample.tail, tail_cut, false) {
        return Ok(ContentKind::Text);
    }
    Err(FileRefusal::NotOnList)
}

/// Where a stored object stands, from the upload policy. Nothing past `Ready` is modeled yet: abandoned uploads and removal
/// come with their own steps.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ObjectState {
    /// Not all of the file has arrived.
    Uploading,
    /// Waiting for the result.
    Scanning,
    /// The scanner reported nothing. Screens say "No known malware found", never that it's safe.
    Ready,
    /// The scanner found something or couldn't read the file.
    Blocked,
    /// No result within an hour. Upload the file again.
    Failed,
    /// Taken down by an owner or admin: the bytes are gone, and the record and hash stay. Nothing leaves it, see
    /// [`crate::removal`].
    Removed,
}

impl ObjectState {
    pub const ALL: [ObjectState; 6] = [
        ObjectState::Uploading,
        ObjectState::Scanning,
        ObjectState::Ready,
        ObjectState::Blocked,
        ObjectState::Failed,
        ObjectState::Removed,
    ];

    pub fn name(self) -> &'static str {
        match self {
            ObjectState::Uploading => "uploading",
            ObjectState::Scanning => "scanning",
            ObjectState::Ready => "ready",
            ObjectState::Blocked => "blocked",
            ObjectState::Failed => "failed",
            ObjectState::Removed => "removed",
        }
    }

    /// Unknown names answer `None`, so a bad row can't read as an allowed state.
    pub fn from_name(name: &str) -> Option<ObjectState> {
        ObjectState::ALL.into_iter().find(|s| s.name() == name)
    }

    /// Only a file the scanner reported nothing about can be downloaded or approved.
    pub fn is_available(self) -> bool {
        match self {
            ObjectState::Ready => true,
            ObjectState::Uploading
            | ObjectState::Scanning
            | ObjectState::Blocked
            | ObjectState::Failed
            | ObjectState::Removed => false,
        }
    }
}

/// What the Worker found once the bytes stopped arriving. Its `Debug` prints sizes only: an announced hash is whatever the
/// sender wrote.
#[derive(Clone, Copy)]
pub struct Arrival<'a> {
    pub announced_size: u64,
    pub announced_sha256: &'a str,
    pub received_size: u64,
    pub received_sha256: &'a str,
    pub sample: FileSample<'a>,
}

impl fmt::Debug for Arrival<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Arrival")
            .field("announced_size", &self.announced_size)
            .field("received_size", &self.received_size)
            .field("sample", &self.sample)
            .finish()
    }
}

/// Lower-case hex, the only form one is compared in.
pub fn is_sha256(hash: &str) -> bool {
    hash.len() == 64 && hash.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CompletedUpload {
    pub state: ObjectState,
    pub kind: ContentKind,
}

/// Moves a file to scanning, only if what arrived is what was announced and its content is allowed. A refusal leaves the
/// object uploading, where nothing can download it.
pub fn complete_upload(
    state: ObjectState,
    arrival: &Arrival<'_>,
) -> Result<CompletedUpload, FileRefusal> {
    match state {
        ObjectState::Uploading => {}
        ObjectState::Scanning
        | ObjectState::Ready
        | ObjectState::Blocked
        | ObjectState::Failed
        | ObjectState::Removed => return Err(FileRefusal::InvalidTransition),
    }
    if arrival.received_size != arrival.announced_size
        || arrival.sample.total_size != arrival.received_size
        || !is_sha256(arrival.received_sha256)
        || arrival.received_sha256 != arrival.announced_sha256
    {
        return Err(FileRefusal::Mismatch);
    }
    if arrival.received_size > MAX_FILE_BYTES {
        return Err(FileRefusal::TooLarge);
    }
    let kind = classify(&arrival.sample)?;
    Ok(CompletedUpload {
        state: ObjectState::Scanning,
        kind,
    })
}

/// What a scanner said. There's deliberately no way to report "safe".
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScanOutcome {
    NoKnownMalware,
    MalwareFound,
    Unreadable,
}

impl ScanOutcome {
    /// Reads a report. Only the exact words for "found nothing" count as that, and anything else blocks the file.
    pub fn from_report(report: &str) -> ScanOutcome {
        match report {
            "no_known_malware" => ScanOutcome::NoKnownMalware,
            "malware_found" => ScanOutcome::MalwareFound,
            _ => ScanOutcome::Unreadable,
        }
    }
}

fn scan_is_late(scanning_since: i64, now: i64) -> bool {
    now.saturating_sub(scanning_since) >= SCAN_DEADLINE_MS
}

/// Records a scanner's report. Reports can arrive twice or late, so a report can only ever tighten: nothing leaves
/// blocked or failed for ready, a finding blocks whatever the state was, and a clean report after the deadline is too late.
/// A removed file stays removed, whatever arrives.
pub fn record_scan(
    state: ObjectState,
    outcome: ScanOutcome,
    scanning_since: i64,
    now: i64,
) -> Result<ObjectState, FileRefusal> {
    match (state, outcome) {
        (ObjectState::Uploading, _) => Err(FileRefusal::InvalidTransition),
        (ObjectState::Removed, _) => Ok(ObjectState::Removed),
        (_, ScanOutcome::MalwareFound | ScanOutcome::Unreadable) => Ok(ObjectState::Blocked),
        (ObjectState::Scanning, ScanOutcome::NoKnownMalware) => {
            if scan_is_late(scanning_since, now) {
                Ok(ObjectState::Failed)
            } else {
                Ok(ObjectState::Ready)
            }
        }
        (
            ObjectState::Ready | ObjectState::Blocked | ObjectState::Failed,
            ScanOutcome::NoKnownMalware,
        ) => Ok(state),
    }
}

/// Whether the scanner's shared secret can ever match a header. A header can't carry whitespace at either end, so a secret with
/// any there, or nothing but whitespace, would refuse every report, and counts as unset.
pub fn scanner_secret_usable(secret: &str) -> bool {
    !secret.is_empty() && secret.trim() == secret
}

/// Whether a scanner's signature database can stand behind a clean report: a named engine, a version of digits and a build time
/// within decision 84's week, each within its length. `built_at_ms` is the build time already read, or `None` if it isn't a time.
pub fn scan_database_fits(
    engine: &str,
    version: &str,
    built_at: &str,
    built_at_ms: Option<i64>,
    now: i64,
) -> bool {
    let named = !engine.is_empty() && engine.len() <= MAX_SCAN_ENGINE_BYTES;
    let numbered = !version.is_empty()
        && version.len() <= MAX_SCAN_VERSION_BYTES
        && version.bytes().all(|b| b.is_ascii_digit());
    let fresh = built_at.len() <= MAX_SCAN_BUILT_AT_BYTES
        && built_at_ms.is_some_and(|at| {
            let age = now.saturating_sub(at);
            (-MAX_SIGNATURES_AHEAD_MS..=MAX_SIGNATURE_AGE_MS).contains(&age)
        });
    named && numbered && fresh
}

/// What a state becomes when the room's alarm looks at it: a scan with no result after an hour fails.
pub fn expire_scan(state: ObjectState, scanning_since: i64, now: i64) -> ObjectState {
    match state {
        ObjectState::Scanning if scan_is_late(scanning_since, now) => ObjectState::Failed,
        ObjectState::Uploading
        | ObjectState::Scanning
        | ObjectState::Ready
        | ObjectState::Blocked
        | ObjectState::Failed
        | ObjectState::Removed => state,
    }
}
