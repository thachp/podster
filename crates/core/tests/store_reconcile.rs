#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]
//! The reconcile of rooms' app stores (S5 of the store plan, its second PR): what one room's record says against a
//! whole list of D1's databases, when a made store read gone counts, when a listed store no room records is an orphan,
//! and when a walk that keeps missing rooms is told. Each decision is shown against a case one change away that decides
//! the other way (review standard 2).

use podster_core::app_store::{StoreRecord, GONE_SPAN_MS};
use podster_core::store_reconcile::*;

const ID: &str = "0123abcd-4567-89ef-0123-456789abcdef";
const OTHER_ID: &str = "fedcba98-7654-3210-fedc-ba9876543210";
const NAME: &str = "podster-store-00112233445566778899aabbccddeeff";
const OTHER_NAME: &str = "podster-store-ffeeddccbbaa99887766554433221100";
/// When the record's create was sent, for a record whose create is outstanding or made.
const SENT: Option<i64> = Some(1);

fn made() -> StoreRecord<'static> {
    StoreRecord {
        kind: Some("d1"),
        name: Some(NAME),
        id: Some(ID),
        made_at: Some(2),
        delete_owed_at: None,
        gone_at: None,
    }
}

fn unmade() -> StoreRecord<'static> {
    StoreRecord {
        id: None,
        made_at: None,
        ..made()
    }
}

fn list(entries: &[(&str, &str)]) -> Vec<(String, String)> {
    entries
        .iter()
        .map(|(id, name)| ((*id).to_owned(), (*name).to_owned()))
        .collect()
}

fn check(record: &StoreRecord<'_>, entries: &[(&str, &str)]) -> RecordCheck {
    check_record(record, SENT, &list(entries))
}

#[test]
fn a_made_store_listed_by_its_id_and_name_is_fine() {
    assert_eq!(check(&made(), &[(ID, NAME)]), RecordCheck::Fine);
}

#[test]
fn a_made_store_not_listed_is_read_by_its_id() {
    assert_eq!(check(&made(), &[]), RecordCheck::ReadById);
    // Listed under another name, or another ID under its name: neither says it is there, so the read decides.
    assert_eq!(check(&made(), &[(ID, OTHER_NAME)]), RecordCheck::ReadById);
    assert_eq!(check(&made(), &[(OTHER_ID, NAME)]), RecordCheck::ReadById);
}

#[test]
fn a_store_owed_a_deletion_or_gone_is_left_to_its_deletion() {
    let owed = StoreRecord {
        delete_owed_at: Some(3),
        ..made()
    };
    assert_eq!(check(&owed, &[]), RecordCheck::Fine);
    let gone = StoreRecord {
        gone_at: Some(4),
        ..owed.clone()
    };
    assert_eq!(check(&gone, &[]), RecordCheck::Fine);
    // An unmade record owed a deletion is never settled: nothing is recorded made that is owed going.
    let unmade_owed = StoreRecord {
        delete_owed_at: Some(3),
        ..unmade()
    };
    assert_eq!(check(&unmade_owed, &[(ID, NAME)]), RecordCheck::Fine);
}

#[test]
fn a_name_with_no_id_that_the_list_shows_is_settled_by_the_listed_id_while_its_create_is_outstanding(
) {
    assert_eq!(
        check(&unmade(), &[(OTHER_ID, OTHER_NAME), (ID, NAME)]),
        RecordCheck::Settle(ID.to_owned())
    );
    // Not listed: the release job's to settle, nothing here.
    assert_eq!(
        check(&unmade(), &[(OTHER_ID, OTHER_NAME)]),
        RecordCheck::Fine
    );
}

#[test]
fn a_name_whose_create_was_cleared_that_the_list_shows_is_told_and_never_adopted() {
    assert_eq!(
        check_record(&unmade(), None, &list(&[(ID, NAME)])),
        RecordCheck::Reappeared
    );
    // Cleared and not listed: nothing.
    assert_eq!(
        check_record(&unmade(), None, &list(&[(OTHER_ID, OTHER_NAME)])),
        RecordCheck::Fine
    );
}

#[test]
fn a_record_not_of_the_rooms_form_decides_nothing() {
    for record in [
        StoreRecord {
            kind: Some("kv"),
            ..made()
        },
        StoreRecord {
            name: Some("podster-store-xyz"),
            ..unmade()
        },
        StoreRecord {
            made_at: None,
            ..made()
        },
        StoreRecord {
            id: Some("NOT-AN-ID"),
            ..made()
        },
        StoreRecord {
            gone_at: Some(4),
            ..made()
        },
    ] {
        assert_eq!(
            check(&record, &[(ID, NAME)]),
            RecordCheck::Unknown,
            "{record:?}"
        );
    }
}

#[test]
fn a_store_read_gone_counts_only_on_a_second_read_at_least_ten_minutes_after_the_first() {
    assert_eq!(gone_step(None, 1_000), GoneStep::Note);
    let first = 1_000;
    assert_eq!(gone_step(Some(first), first), GoneStep::Wait);
    assert_eq!(
        gone_step(Some(first), first + GONE_SPAN_MS - 1),
        GoneStep::Wait
    );
    assert_eq!(
        gone_step(Some(first), first + GONE_SPAN_MS),
        GoneStep::Confirmed
    );
    assert_eq!(
        gone_step(Some(first), first + GONE_SPAN_MS + 1),
        GoneStep::Confirmed
    );
    // A first read stamped ahead of the clock is never confirmed by it.
    assert_eq!(gone_step(Some(first), first - 1), GoneStep::Wait);
}

#[test]
fn an_unrecorded_store_is_an_orphan_only_at_the_end_of_a_whole_walk_after_the_one_it_was_first_listed_in(
) {
    let walk = 7;
    assert!(is_orphan(walk - 1, false, walk, true));
    assert!(is_orphan(walk - 3, false, walk, true));
    // First listed in this walk: its room may have been asked before it recorded the name.
    assert!(!is_orphan(walk, false, walk, true));
    assert!(!is_orphan(walk + 1, false, walk, true));
    // A room recorded it in this walk.
    assert!(!is_orphan(walk - 1, true, walk, true));
    // A walk some room didn't answer decides nothing.
    assert!(!is_orphan(walk - 1, false, walk, false));
}

#[test]
fn a_walk_that_keeps_missing_rooms_is_told_from_the_third_in_a_row() {
    assert!(!unwhole_told(0));
    assert!(!unwhole_told(UNWHOLE_WALKS_TOLD - 1));
    assert!(unwhole_told(UNWHOLE_WALKS_TOLD));
    assert!(unwhole_told(UNWHOLE_WALKS_TOLD + 1));
    assert_eq!(UNWHOLE_WALKS_TOLD, 3);
}

#[test]
fn a_podster_named_store_is_any_name_with_the_prefix() {
    assert!(podster_named(NAME));
    // Malformed after the prefix: no room can record it, so it is still Podster-named, never Podster's own.
    assert!(podster_named("podster-store-xyz"));
    assert!(!podster_named("podster-storex"));
    assert!(!podster_named("app-db"));
    assert!(!podster_named(
        "Podster-store-00112233445566778899aabbccddeeff"
    ));
}
