#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use podster_core::files::{
    complete_upload, expire_scan, record_scan, Arrival, FileRefusal, FileSample, ObjectState,
    ScanOutcome,
};
use podster_core::removal::*;
use ObjectState::*;

const NOW: i64 = 1_800_000_000_000;
const HOUR: i64 = 60 * 60 * 1000;
const ROOM: &str = "ws_1";

#[test]
fn removing_ends_every_state_in_removed_and_remembers_what_it_was() {
    for state in [Uploading, Scanning, Ready, Blocked, Failed] {
        assert_eq!(
            remove_file(state),
            Removal::Removed { was: state },
            "{state:?}"
        );
    }
    assert_eq!(remove_file(Removed), Removal::AlreadyRemoved);
}

#[test]
fn nothing_leaves_removed() {
    for outcome in [
        ScanOutcome::NoKnownMalware,
        ScanOutcome::MalwareFound,
        ScanOutcome::Unreadable,
    ] {
        assert_eq!(
            record_scan(Removed, outcome, NOW, NOW),
            Ok(Removed),
            "{outcome:?}"
        );
        assert_eq!(
            record_scan(Removed, outcome, NOW - 2 * HOUR, NOW),
            Ok(Removed),
            "{outcome:?} late"
        );
    }
    assert_eq!(expire_scan(Removed, NOW - 2 * HOUR, NOW), Removed);
    let hash = "a".repeat(64);
    let arrival = Arrival {
        announced_size: 3,
        announced_sha256: &hash,
        received_size: 3,
        received_sha256: &hash,
        sample: FileSample {
            head: b"abc",
            tail: b"abc",
            total_size: 3,
        },
    };
    assert_eq!(
        complete_upload(Removed, &arrival).err(),
        Some(FileRefusal::InvalidTransition)
    );
}

#[test]
fn a_removed_file_is_never_available_and_its_name_says_nothing_of_safety() {
    assert!(!Removed.is_available());
    assert_eq!(Removed.name(), "removed");
    assert_eq!(ObjectState::from_name("removed"), Some(Removed));
    assert!(ObjectState::ALL.contains(&Removed));
}

#[test]
fn only_live_files_and_unexpired_uploads_hold_space() {
    assert!(holds_space(Uploading, NOW + 1, NOW));
    assert!(!holds_space(Uploading, NOW, NOW));
    assert!(!holds_space(Uploading, NOW - 1, NOW));
    for state in [Scanning, Ready, Blocked, Failed] {
        assert!(holds_space(state, NOW - 10 * HOUR, NOW), "{state:?}");
    }
    assert!(!holds_space(Removed, NOW + HOUR, NOW));
}

#[test]
fn an_upload_is_abandoned_only_an_hour_after_its_grant_expires() {
    assert!(!is_abandoned(Uploading, NOW, NOW));
    assert!(!is_abandoned(
        Uploading,
        NOW - ABANDONED_UPLOAD_GRACE_MS + 1,
        NOW
    ));
    assert!(is_abandoned(
        Uploading,
        NOW - ABANDONED_UPLOAD_GRACE_MS,
        NOW
    ));
    assert!(is_abandoned(Uploading, i64::MIN, NOW));
    assert!(!is_abandoned(Uploading, i64::MAX, NOW));
    for state in [Scanning, Ready, Blocked, Failed, Removed] {
        assert!(!is_abandoned(state, i64::MIN, NOW), "{state:?}");
    }
}

#[test]
fn the_grace_covers_the_longest_attempt_and_the_rooms_answer() {
    let longest_attempt = 30 * 60 * 1000 + 30 * 1000;
    assert!(ABANDONED_UPLOAD_GRACE_MS > longest_attempt);
    assert!(UNREFERENCED_BYTES_GRACE_MS > longest_attempt);
}

#[test]
fn a_room_key_has_the_room_object_and_attempt_and_nothing_else() {
    assert_eq!(room_prefix(ROOM), "rooms/ws_1/objects/");
    assert!(is_room_key(ROOM, "rooms/ws_1/objects/obj_1/abc"));
    for key in [
        "rooms/ws_1/objects/obj_1",
        "rooms/ws_1/objects/obj_1/",
        "rooms/ws_1/objects//abc",
        "rooms/ws_1/objects/obj_1/abc/more",
        "rooms/ws_2/objects/obj_1/abc",
        "rooms/ws_10/objects/obj_1/abc",
        "rooms/ws_1/other/obj_1/abc",
        "ROOMS/ws_1/objects/obj_1/abc",
        "/rooms/ws_1/objects/obj_1/abc",
        "",
    ] {
        assert!(!is_room_key(ROOM, key), "{key:?}");
    }
    for room in ["", "ws_1/objects", "/"] {
        assert!(
            !is_room_key(room, "rooms/ws_1/objects/obj_1/abc"),
            "{room:?}"
        );
        assert!(
            !is_room_key(room, &format!("rooms/{room}/objects/obj_1/abc")),
            "{room:?}"
        );
    }
}

#[test]
fn bytes_a_file_refers_to_stay_however_old() {
    let key = "rooms/ws_1/objects/obj_1/abc";
    for state in [Uploading, Scanning, Ready, Blocked, Failed] {
        assert!(
            !delete_stored_bytes(ROOM, key, KeyHolder::File(state), i64::MIN, NOW),
            "{state:?}"
        );
    }
}

#[test]
fn a_removed_files_bytes_go_at_once() {
    assert!(delete_stored_bytes(
        ROOM,
        "rooms/ws_1/objects/obj_1/abc",
        KeyHolder::File(Removed),
        NOW,
        NOW
    ));
    assert!(delete_stored_bytes(
        ROOM,
        "rooms/ws_1/objects/obj_1/abc",
        KeyHolder::File(Removed),
        NOW + HOUR,
        NOW
    ));
}

#[test]
fn bytes_nobody_refers_to_go_once_old_enough_and_never_from_the_future() {
    let key = "rooms/ws_1/objects/obj_1/abc";
    assert!(!delete_stored_bytes(ROOM, key, KeyHolder::Nobody, NOW, NOW));
    assert!(!delete_stored_bytes(
        ROOM,
        key,
        KeyHolder::Nobody,
        NOW - UNREFERENCED_BYTES_GRACE_MS + 1,
        NOW
    ));
    assert!(delete_stored_bytes(
        ROOM,
        key,
        KeyHolder::Nobody,
        NOW - UNREFERENCED_BYTES_GRACE_MS,
        NOW
    ));
    assert!(delete_stored_bytes(
        ROOM,
        key,
        KeyHolder::Nobody,
        i64::MIN,
        NOW
    ));
    assert!(!delete_stored_bytes(
        ROOM,
        key,
        KeyHolder::Nobody,
        NOW + HOUR,
        NOW
    ));
}

#[test]
fn nothing_outside_the_room_is_ever_deleted() {
    for key in [
        "rooms/ws_2/objects/obj_1/abc",
        "rooms/ws_1/objects/obj_1",
        "other",
    ] {
        for holder in [KeyHolder::Nobody, KeyHolder::File(Removed)] {
            assert!(
                !delete_stored_bytes(ROOM, key, holder, i64::MIN, NOW),
                "{key:?} {holder:?}"
            );
        }
    }
}

#[test]
fn blocked_and_failed_files_go_seven_days_after_the_verdict_and_nothing_else_does() {
    const WEEK: i64 = 7 * 24 * HOUR;
    assert_eq!(UNUSABLE_FILE_RETENTION_MS, WEEK);
    for state in [Blocked, Failed] {
        assert_eq!(unusable_file_due(state, NOW), Some(NOW + WEEK), "{state:?}");
        assert_eq!(
            unusable_file_due(state, i64::MAX),
            Some(i64::MAX),
            "{state:?}"
        );
    }
    for state in [Uploading, Scanning, Ready, Removed] {
        assert_eq!(unusable_file_due(state, NOW), None, "{state:?}");
    }
}

#[test]
fn an_unsubmitted_file_goes_a_day_after_its_task_leaves_accepted() {
    const DAY: i64 = 24 * HOUR;
    assert_eq!(UNSUBMITTED_FILE_RETENTION_MS, DAY);
    for state in [Uploading, Scanning, Ready, Blocked, Failed] {
        assert_eq!(
            unsubmitted_file_due(state, false, Some(NOW)),
            Some(NOW + DAY),
            "{state:?}"
        );
        assert_eq!(
            unsubmitted_file_due(state, false, None),
            None,
            "{state:?} still accepted"
        );
        assert_eq!(
            unsubmitted_file_due(state, true, Some(NOW)),
            None,
            "{state:?} submitted"
        );
    }
    assert_eq!(unsubmitted_file_due(Removed, false, Some(NOW)), None);
}
