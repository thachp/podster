#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]
//! Rule 3(b) (S5 of the store plan): what an app's script may be bound to, the ceiling on what the check may suspend,
//! and when a script that keeps reading unknown is told. Each foreign kind is shown beside the one change that makes
//! it the app's own store, so no assertion passes whatever the rule does (review standard 2).

use podster_core::app_bindings::*;
use podster_core::app_store::{store_name, StoreRecord};
use podster_core::release::REPO_UNPUBLISH_WINDOW_MS;

const OWN: &str = "0123abcd-4567-89ef-0123-456789abcdef";
const OTHER: &str = "fedcba98-7654-3210-fedc-ba9876543210";
const SERVE: &str = "d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1";

fn store(id: &str) -> ReadBinding<'_> {
    ReadBinding {
        kind: Some("d1"),
        name: Some("STORE"),
        id: Some(id),
        ..ReadBinding::default()
    }
}

fn verdict(bindings: &[ReadBinding<'_>]) -> Verdict {
    check(Read::List(bindings), OwnStore::Recorded(OWN), Some(SERVE))
}

fn service() -> ReadBinding<'static> {
    ReadBinding {
        kind: Some("service"),
        name: Some("API"),
        ..ReadBinding::default()
    }
}

#[test]
fn a_script_with_nothing_or_its_own_store_alone_is_clean() {
    assert_eq!(verdict(&[]), Verdict::Clean);
    assert_eq!(verdict(&[store(OWN)]), Verdict::Clean);
    assert_eq!(check(Read::List(&[]), OwnStore::None, None), Verdict::Clean);
}

#[test]
fn another_store_is_foreign_and_its_own_is_not() {
    assert_eq!(
        verdict(&[store(OTHER)]),
        Verdict::Foreign(Foreign::OtherStore)
    );
    assert_eq!(
        check(
            Read::List(&[store(OTHER)]),
            OwnStore::Recorded(OTHER),
            Some(SERVE)
        ),
        Verdict::Clean
    );
    // Another database under another name.
    let renamed_other = ReadBinding {
        name: Some("DB"),
        ..store(OTHER)
    };
    assert_eq!(
        verdict(&[renamed_other.clone()]),
        Verdict::Foreign(Foreign::OtherStore)
    );
    assert_eq!(
        check(Read::List(&[renamed_other]), OwnStore::None, None),
        Verdict::Foreign(Foreign::OtherStore)
    );
}

#[test]
fn its_own_store_a_second_time_under_another_name_has_its_own_code() {
    let renamed = ReadBinding {
        name: Some("DB"),
        ..store(OWN)
    };
    assert_eq!(
        verdict(&[store(OWN), renamed.clone()]),
        Verdict::Foreign(Foreign::StoreOwnTwice)
    );
    assert_eq!(
        verdict(&[renamed]),
        Verdict::Foreign(Foreign::StoreOwnTwice)
    );
}

#[test]
fn a_store_bound_while_none_is_recorded_is_foreign() {
    assert_eq!(
        check(Read::List(&[store(OWN)]), OwnStore::None, None),
        Verdict::Foreign(Foreign::StoreUnrecorded)
    );
}

#[test]
fn the_write_counter_is_foreign_by_its_class_on_any_entry() {
    let counter = ReadBinding {
        kind: Some("durable_object_namespace"),
        name: Some("COUNTER"),
        class_name: Some("WriteCounter"),
        ..ReadBinding::default()
    };
    assert_eq!(
        verdict(std::slice::from_ref(&counter)),
        Verdict::Foreign(Foreign::WriteCounter)
    );
    let other_class = ReadBinding {
        class_name: Some("Writecounter"),
        ..counter.clone()
    };
    assert_eq!(
        verdict(&[other_class]),
        Verdict::Foreign(Foreign::DurableObject)
    );
    let disguised = ReadBinding {
        class_name: Some("WriteCounter"),
        ..store(OWN)
    };
    assert_eq!(
        verdict(&[disguised]),
        Verdict::Foreign(Foreign::WriteCounter)
    );
    // With no type and no name at all, the class still says what it is.
    let bare = ReadBinding {
        class_name: Some("WriteCounter"),
        ..ReadBinding::default()
    };
    assert_eq!(verdict(&[bare]), Verdict::Foreign(Foreign::WriteCounter));
    assert_eq!(
        verdict(&[store(OTHER), counter]),
        Verdict::Foreign(Foreign::WriteCounter)
    );
}

#[test]
fn the_serve_entries_namespace_is_told_apart_from_any_other_kv() {
    let kv = |namespace: &'static str| ReadBinding {
        kind: Some("kv_namespace"),
        name: Some("STORE"),
        namespace_id: Some(namespace),
        ..ReadBinding::default()
    };
    assert_eq!(
        verdict(&[kv(SERVE)]),
        Verdict::Foreign(Foreign::ServeEntries)
    );
    assert_eq!(
        verdict(&[kv("aa".repeat(16).leak())]),
        Verdict::Foreign(Foreign::KvNamespace)
    );
    assert_eq!(
        check(Read::List(&[kv(SERVE)]), OwnStore::Recorded(OWN), None),
        Verdict::Foreign(Foreign::KvNamespace)
    );
    // No namespace never matches an unknown serve-entry namespace as `None == None`.
    let bare = ReadBinding {
        namespace_id: None,
        ..kv(SERVE)
    };
    assert_eq!(
        check(Read::List(&[bare]), OwnStore::Recorded(OWN), None),
        Verdict::Foreign(Foreign::KvNamespace)
    );
    // A KV binding with no name is still a KV binding.
    let nameless = ReadBinding {
        name: None,
        ..kv(SERVE)
    };
    assert_eq!(
        verdict(&[nameless]),
        Verdict::Foreign(Foreign::ServeEntries)
    );
}

#[test]
fn every_other_kind_is_foreign() {
    for kind in [
        "service",
        "secret_text",
        "plain_text",
        "r2_bucket",
        "assets",
        "queue",
        "D1",
        "d1 ",
    ] {
        let binding = ReadBinding {
            kind: Some(kind),
            name: Some("STORE"),
            id: Some(OWN),
            ..ReadBinding::default()
        };
        assert_eq!(
            verdict(&[binding]),
            Verdict::Foreign(Foreign::Other),
            "{kind}"
        );
    }
    let durable = ReadBinding {
        kind: Some("durable_object_namespace"),
        name: None,
        class_name: Some("Other"),
        ..ReadBinding::default()
    };
    assert_eq!(
        verdict(&[durable]),
        Verdict::Foreign(Foreign::DurableObject)
    );
}

#[test]
fn its_own_store_twice_under_store_is_foreign() {
    assert_eq!(
        verdict(&[store(OWN), store(OWN)]),
        Verdict::Foreign(Foreign::StoreTwice)
    );
}

#[test]
fn an_answer_longer_than_any_list_is_foreign() {
    assert_eq!(
        check(Read::Oversized, OwnStore::Recorded(OWN), Some(SERVE)),
        Verdict::Foreign(Foreign::Oversized)
    );
    assert_eq!(
        check(Read::Oversized, OwnStore::Unreadable, None),
        Verdict::Foreign(Foreign::Oversized)
    );
}

#[test]
fn unknown_decides_nothing_only_when_nothing_foreign_was_read() {
    assert_eq!(
        check(Read::Unread, OwnStore::Recorded(OWN), Some(SERVE)),
        Verdict::Unknown
    );
    let no_type = ReadBinding {
        kind: None,
        ..store(OWN)
    };
    let no_name = ReadBinding {
        name: None,
        ..store(OWN)
    };
    let not_an_object = ReadBinding::default();
    assert_eq!(verdict(std::slice::from_ref(&no_type)), Verdict::Unknown);
    assert_eq!(verdict(std::slice::from_ref(&no_name)), Verdict::Unknown);
    assert_eq!(
        verdict(std::slice::from_ref(&not_an_object)),
        Verdict::Unknown
    );
    // Beside its own store, an entry that can't be judged still leaves it unknown.
    assert_eq!(
        verdict(&[store(OWN), not_an_object.clone()]),
        Verdict::Unknown
    );
    // But a foreign entry read anywhere in the list decides it, before or after the unreadable one.
    assert_eq!(
        verdict(&[no_type.clone(), store(OTHER)]),
        Verdict::Foreign(Foreign::OtherStore)
    );
    assert_eq!(
        verdict(&[store(OTHER), no_type]),
        Verdict::Foreign(Foreign::OtherStore)
    );
    assert_eq!(
        verdict(&[not_an_object, service(), no_name]),
        Verdict::Foreign(Foreign::Other)
    );
    for id in [
        None,
        Some("not-an-id"),
        Some("0123ABCD-4567-89EF-0123-456789ABCDEF"),
    ] {
        let unread = ReadBinding { id, ..store(OWN) };
        assert_eq!(
            verdict(std::slice::from_ref(&unread)),
            Verdict::Unknown,
            "{id:?}"
        );
        assert_eq!(
            verdict(&[unread, service()]),
            Verdict::Foreign(Foreign::Other),
            "{id:?}"
        );
    }
    // The room's record unreadable: no store binding can be told, but other kinds still can.
    assert_eq!(
        check(Read::List(&[store(OWN)]), OwnStore::Unreadable, Some(SERVE)),
        Verdict::Unknown
    );
    assert_eq!(
        check(
            Read::List(&[store(OTHER), service()]),
            OwnStore::Unreadable,
            None
        ),
        Verdict::Foreign(Foreign::Other)
    );
    let renamed = ReadBinding {
        name: Some("DB"),
        ..store(OWN)
    };
    assert_eq!(
        check(
            Read::List(&[store(OWN), renamed]),
            OwnStore::Unreadable,
            None
        ),
        Verdict::Foreign(Foreign::OtherStore)
    );
}

#[test]
fn the_codes_are_each_distinct_and_of_a_findings_form() {
    let all = [
        Foreign::WriteCounter,
        Foreign::ServeEntries,
        Foreign::OtherStore,
        Foreign::StoreUnrecorded,
        Foreign::StoreOwnTwice,
        Foreign::DurableObject,
        Foreign::KvNamespace,
        Foreign::StoreTwice,
        Foreign::Other,
        Foreign::Oversized,
    ];
    let mut codes: Vec<&str> = all.iter().map(|f| f.code()).collect();
    for code in &codes {
        assert!((1..=64).contains(&code.len()));
        assert!(code.bytes().all(|b| b.is_ascii_lowercase() || b == b'_'));
    }
    codes.sort_unstable();
    codes.dedup();
    assert_eq!(codes.len(), all.len());
    for code in [
        BINDING_FOREIGN,
        BINDING_HELD,
        BINDINGS_UNREAD,
        BINDINGS_KEEP_UNREAD,
    ] {
        assert!(code.bytes().all(|b| b.is_ascii_lowercase() || b == b'_'));
    }
}

fn record(name: &str) -> StoreRecord<'_> {
    StoreRecord {
        kind: Some("d1"),
        name: Some(name),
        id: Some(OWN),
        made_at: Some(5),
        delete_owed_at: None,
        gone_at: None,
    }
}

#[test]
fn the_own_store_is_the_records_id_while_it_is_owed_a_deletion_or_gone() {
    let name = store_name(7);
    assert_eq!(own_store(None), OwnStore::None);
    assert_eq!(own_store(Some(&record(&name))), OwnStore::Recorded(OWN));
    let owed = StoreRecord {
        delete_owed_at: Some(9),
        ..record(&name)
    };
    assert_eq!(own_store(Some(&owed)), OwnStore::Recorded(OWN));
    let gone = StoreRecord {
        gone_at: Some(10),
        ..owed.clone()
    };
    assert_eq!(own_store(Some(&gone)), OwnStore::Recorded(OWN));
    let outstanding = StoreRecord {
        id: None,
        made_at: None,
        ..record(&name)
    };
    assert_eq!(own_store(Some(&outstanding)), OwnStore::None);
}

#[test]
fn a_record_not_of_the_rooms_form_is_unreadable() {
    let name = store_name(7);
    let cases = [
        StoreRecord {
            kind: None,
            ..record(&name)
        },
        StoreRecord {
            kind: Some("kv"),
            ..record(&name)
        },
        StoreRecord {
            name: None,
            ..record(&name)
        },
        StoreRecord {
            name: Some("podster-store-x"),
            ..record(&name)
        },
        StoreRecord {
            gone_at: Some(1),
            ..record(&name)
        },
        StoreRecord {
            made_at: None,
            ..record(&name)
        },
        StoreRecord {
            id: None,
            ..record(&name)
        },
        StoreRecord {
            id: Some("0123ABCD-4567-89EF-0123-456789ABCDEF"),
            ..record(&name)
        },
    ];
    for case in &cases {
        assert_eq!(own_store(Some(case)), OwnStore::Unreadable, "{case:?}");
    }
}

#[test]
fn the_ceiling_allows_the_repository_unpublishs_share_in_a_rolling_hour() {
    let now = 10 * REPO_UNPUBLISH_WINDOW_MS;
    // With 100 rooms with apps the ceiling is 5: four used allows one more, five doesn't.
    let at = |n: usize| vec![now - 1; n];
    assert_eq!(
        suspension_permit(&at(4), Some(100), now),
        SuspensionPermit::Allowed
    );
    assert_eq!(
        suspension_permit(&at(5), Some(100), now),
        SuspensionPermit::Ceiling
    );
    // 10% of 20 rooms is 2.
    assert_eq!(
        suspension_permit(&at(1), Some(20), now),
        SuspensionPermit::Allowed
    );
    assert_eq!(
        suspension_permit(&at(2), Some(20), now),
        SuspensionPermit::Ceiling
    );
    // Never below one, even with no room counted.
    assert_eq!(
        suspension_permit(&[], Some(0), now),
        SuspensionPermit::Allowed
    );
    assert_eq!(
        suspension_permit(&at(1), Some(0), now),
        SuspensionPermit::Ceiling
    );
    // Rooms not counted: nothing is suspended, and it is asked again.
    assert_eq!(suspension_permit(&[], None, now), SuspensionPermit::Unknown);
    // The hour's edge, to the millisecond: one made a whole window ago no longer counts; one a millisecond later does.
    let edge = vec![now - REPO_UNPUBLISH_WINDOW_MS; 5];
    assert_eq!(
        suspension_permit(&edge, Some(100), now),
        SuspensionPermit::Allowed
    );
    let inside = vec![now - REPO_UNPUBLISH_WINDOW_MS + 1; 5];
    assert_eq!(
        suspension_permit(&inside, Some(100), now),
        SuspensionPermit::Ceiling
    );
    assert_eq!(SuspensionPermit::Allowed.held_code(), None);
    assert_eq!(
        SuspensionPermit::Ceiling.held_code(),
        Some("ceiling_reached")
    );
    assert_eq!(
        SuspensionPermit::Unknown.held_code(),
        Some("ceiling_unread")
    );
}

#[test]
fn a_script_is_told_by_name_from_its_third_unread_pass() {
    assert_eq!(UNREAD_PASSES_TOLD, 3);
    assert!(!unread_told(2));
    assert!(unread_told(3));
    assert!(unread_told(4));
}

#[test]
fn the_write_counter_class_is_the_one_the_content_worker_exports() {
    let source = include_str!("../../../apps/content/src/counter.ts");
    assert!(
        source.contains(&format!("export class {WRITE_COUNTER_CLASS} ")),
        "apps/content/src/counter.ts no longer exports a class named {WRITE_COUNTER_CLASS}"
    );
}
