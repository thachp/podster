//! Removing a file, and clearing what nobody needs: abandoned uploads, and bytes in storage that no file refers to. No I/O.
//!
//! Rules: [upload policy](../../../docs/spec/UPLOAD-POLICY.md#keeping-and-removing-files). Design:
//! [ADR 0006](../../../docs/adr/0006-uploads-and-scanning.md#removal). Who may remove is `podster_policy::files`.
//!
//! Removing a file keeps its record and hash and ends in [`ObjectState::Removed`], which nothing leaves: no scan report,
//! no upload attempt and no second removal changes it. Every other file lasts the room's life during the preview
//! (decision 56), so the windows here only clear uploads that never finished and bytes that nothing refers to.

use crate::files::ObjectState;

/// How long an abandoned upload's row stays after its grant expires. An attempt that began just before then may run for 30
/// minutes, and the room gets 30 seconds to answer it, so clearing the row any sooner could refuse an upload that was
/// on time.
pub const ABANDONED_UPLOAD_GRACE_MS: i64 = 60 * 60 * 1000;

/// How old bytes nothing refers to must be before they're deleted. The room records a key before any of its bytes are
/// written, so this is a second guard, not the main one: it covers a clock that's off, and an attempt the room hasn't
/// heard the end of.
pub const UNREFERENCED_BYTES_GRACE_MS: i64 = 60 * 60 * 1000;

/// What a removal did. Removing twice is an answer, not an error, so a retried takedown can't fail.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Removal {
    /// Its bytes are to be deleted now. `was` is kept on the record, so the history still says what the file had become.
    Removed { was: ObjectState },
    /// It was already removed, and nothing changes.
    AlreadyRemoved,
}

/// Removes a file whatever state it's in. An unfinished upload ends with it, since every upload step needs `Uploading`,
/// and a blocked or failed file loses bytes nobody could download anyway.
pub fn remove_file(state: ObjectState) -> Removal {
    match state {
        ObjectState::Removed => Removal::AlreadyRemoved,
        ObjectState::Uploading
        | ObjectState::Scanning
        | ObjectState::Ready
        | ObjectState::Blocked
        | ObjectState::Failed => Removal::Removed { was: state },
    }
}

/// Whether a file counts against the room's quota now. An upload holds its reservation until its grant expires, every
/// stored file holds its size, and a removed file holds nothing, because its bytes are gone.
pub fn holds_space(state: ObjectState, upload_expires_at: i64, now: i64) -> bool {
    match state {
        ObjectState::Uploading => upload_expires_at > now,
        ObjectState::Scanning | ObjectState::Ready | ObjectState::Blocked | ObjectState::Failed => {
            true
        }
        ObjectState::Removed => false,
    }
}

/// Whether an upload's row can go. Only one that never finished, well after its grant expired: it reserves nothing by then,
/// and its token can't start an attempt. Every stored or removed file keeps its row.
pub fn is_abandoned(state: ObjectState, upload_expires_at: i64, now: i64) -> bool {
    match state {
        ObjectState::Uploading => {
            now >= upload_expires_at.saturating_add(ABANDONED_UPLOAD_GRACE_MS)
        }
        ObjectState::Scanning
        | ObjectState::Ready
        | ObjectState::Blocked
        | ObjectState::Failed
        | ObjectState::Removed => false,
    }
}

/// The prefix every key for a room's files starts with. A sweep lists only this, and deletes nothing outside it.
pub fn room_prefix(room: &str) -> String {
    format!("rooms/{room}/objects/")
}

/// Whether a stored key is under this room's prefix, with the shape `rooms/{room}/objects/{object}/{attempt}`. A room ID
/// that's empty or holds a `/` matches nothing, so a sweep can't reach another room through a bad ID.
pub fn is_room_key(room: &str, key: &str) -> bool {
    if room.is_empty() || room.contains('/') {
        return false;
    }
    let Some(rest) = key.strip_prefix(&room_prefix(room)) else {
        return false;
    };
    let mut parts = rest.split('/');
    matches!(
        (parts.next(), parts.next(), parts.next()),
        (Some(object), Some(attempt), None) if !object.is_empty() && !attempt.is_empty()
    )
}

/// What the room holds for one stored key: the state of the file whose current key it is, if one is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyHolder {
    /// No file's current key is this one: a replaced attempt, a dropped upload, or an answer the room never gave.
    Nobody,
    /// The file whose current key this is.
    File(ObjectState),
}

/// Whether to delete bytes found in storage under this room. Bytes a file refers to stay, including an upload still
/// waiting for the room's answer. A removed file's bytes go at once, which retries a removal whose delete failed. Anything
/// else goes once it's old enough, and never if it's from the future, since a clock that's wrong should keep bytes, not
/// lose them. A key outside the room is never deleted.
pub fn delete_stored_bytes(
    room: &str,
    key: &str,
    holder: KeyHolder,
    stored_at: i64,
    now: i64,
) -> bool {
    if !is_room_key(room, key) {
        return false;
    }
    match holder {
        KeyHolder::File(ObjectState::Removed) => true,
        KeyHolder::File(
            ObjectState::Uploading
            | ObjectState::Scanning
            | ObjectState::Ready
            | ObjectState::Blocked
            | ObjectState::Failed,
        ) => false,
        KeyHolder::Nobody => now.saturating_sub(stored_at) >= UNREFERENCED_BYTES_GRACE_MS,
    }
}

/// How long a blocked or failed file keeps its bytes after the verdict (decision 94). Nobody can download them, and the time is
/// for looking into a reported false positive.
pub const UNUSABLE_FILE_RETENTION_MS: i64 = 7 * 24 * 60 * 60 * 1000;

/// How long a file uploaded for a task but never submitted lasts after the task leaves Accepted (decision 98).
pub const UNSUBMITTED_FILE_RETENTION_MS: i64 = 24 * 60 * 60 * 1000;

/// When the system removes a file by itself, if ever: a blocked or failed one 7 days after its verdict (decision 94). Every other
/// state answers `None`, so a file that became ready, or was already removed, is never touched.
pub fn unusable_file_due(state: ObjectState, verdict_at: i64) -> Option<i64> {
    match state {
        ObjectState::Blocked | ObjectState::Failed => {
            Some(verdict_at.saturating_add(UNUSABLE_FILE_RETENTION_MS))
        }
        ObjectState::Uploading
        | ObjectState::Scanning
        | ObjectState::Ready
        | ObjectState::Removed => None,
    }
}

/// When the system removes a file uploaded for a task and never submitted (decision 98): 24 hours after the task left Accepted.
/// `left_accepted_at` is `None` while the task is in Accepted, so changes requested restarts the wait. A file any submission
/// names is never touched, and neither is one already removed.
pub fn unsubmitted_file_due(
    state: ObjectState,
    named_by_a_submission: bool,
    left_accepted_at: Option<i64>,
) -> Option<i64> {
    if named_by_a_submission || state == ObjectState::Removed {
        return None;
    }
    left_accepted_at.map(|left| left.saturating_add(UNSUBMITTED_FILE_RETENTION_MS))
}
