#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]
//! The reconcile of rooms' app stores (S5 of the store plan, its second PR): what one room's record says against a
//! whole list of D1's databases, when a made store read gone counts, and when a listed store no room records is an
//! orphan. Each decision is shown against a case one change away that decides the other way (review standard 2).

use podster_core::app_store::{StoreRecord, GONE_SPAN_MS};
use podster_core::store_reconcile::*;

const ID: &str = "0123abcd-4567-89ef-0123-456789abcdef";
const OTHER_ID: &str = "fedcba98-7654-3210-fedc-ba9876543210";
const NAME: &str = "podster-store-00112233445566778899aabbccddeeff";
const OTHER_NAME: &str = "podster-store-ffeeddccbbaa99887766554433221100";

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

#[test]
fn a_made_store_listed_by_its_id_and_name_is_fine() {
    assert_eq!(
        check_record(&made(), &list(&[(ID, NAME)])),
        RecordCheck::Fine
    );
}

#[test]
fn a_made_store_not_listed_is_read_by_its_id() {
    assert_eq!(check_record(&made(), &list(&[])), RecordCheck::ReadById);
    // Listed under another name, or another ID under its name: neither says it is there, so the read decides.
    assert_eq!(
        check_record(&made(), &list(&[(ID, OTHER_NAME)])),
        RecordCheck::ReadById
    );
    assert_eq!(
        check_record(&made(), &list(&[(OTHER_ID, NAME)])),
        RecordCheck::ReadById
    );
}

#[test]
fn a_store_owed_a_deletion_or_gone_is_left_to_its_deletion() {
    let owed = StoreRecord {
        delete_owed_at: Some(3),
        ..made()
    };
    assert_eq!(check_record(&owed, &list(&[])), RecordCheck::Fine);
    let gone = StoreRecord {
        gone_at: Some(4),
        ..owed.clone()
    };
    assert_eq!(check_record(&gone, &list(&[])), RecordCheck::Fine);
    // An unmade record owed a deletion is never settled: nothing is recorded made that is owed going.
    let unmade_owed = StoreRecord {
        delete_owed_at: Some(3),
        ..unmade()
    };
    assert_eq!(
        check_record(&unmade_owed, &list(&[(ID, NAME)])),
        RecordCheck::Fine
    );
}

#[test]
fn a_name_with_no_id_that_the_list_shows_is_settled_by_the_listed_id() {
    assert_eq!(
        check_record(&unmade(), &list(&[(OTHER_ID, OTHER_NAME), (ID, NAME)])),
        RecordCheck::Settle(ID.to_owned())
    );
    // Not listed: the release job's to settle, nothing here.
    assert_eq!(
        check_record(&unmade(), &list(&[(OTHER_ID, OTHER_NAME)])),
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
            check_record(&record, &list(&[(ID, NAME)])),
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
fn an_unrecorded_store_is_an_orphan_only_after_a_whole_walk_begun_after_it_was_listed() {
    let started = 10_000;
    assert!(is_orphan(started - 1, false, started, true));
    // Listed only once the walk had begun: its room may have been asked before it recorded the name.
    assert!(!is_orphan(started, false, started, true));
    assert!(!is_orphan(started + 1, false, started, true));
    // A room recorded it in this walk.
    assert!(!is_orphan(started - 1, true, started, true));
    // A walk some room didn't answer decides nothing.
    assert!(!is_orphan(started - 1, false, started, false));
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
