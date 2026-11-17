#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]
//! Rule 3(b) (S5 of the store plan): what an app's script may be bound to. Each foreign kind is shown beside the one
//! change that makes it the app's own store, so no assertion passes whatever the rule does (review standard 2).

use podster_core::app_bindings::*;
use podster_core::app_store::{store_name, StoreRecord};

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
    check(Some(bindings), OwnStore::Recorded(OWN), Some(SERVE))
}

#[test]
fn a_script_with_nothing_or_its_own_store_alone_is_clean() {
    assert_eq!(verdict(&[]), Verdict::Clean);
    assert_eq!(verdict(&[store(OWN)]), Verdict::Clean);
    // With no store recorded, nothing bound is still clean.
    assert_eq!(check(Some(&[]), OwnStore::None, None), Verdict::Clean);
}

#[test]
fn another_store_under_store_is_foreign_and_its_own_is_not() {
    assert_eq!(
        verdict(&[store(OTHER)]),
        Verdict::Foreign(Foreign::OtherStore)
    );
    assert_eq!(
        check(
            Some(&[store(OTHER)]),
            OwnStore::Recorded(OTHER),
            Some(SERVE)
        ),
        Verdict::Clean
    );
    // The app's own database under any other name is still not its `STORE`.
    let renamed = ReadBinding {
        name: Some("DB"),
        ..store(OWN)
    };
    assert_eq!(verdict(&[renamed]), Verdict::Foreign(Foreign::OtherStore));
}

#[test]
fn a_store_bound_while_none_is_recorded_is_foreign() {
    assert_eq!(
        check(Some(&[store(OWN)]), OwnStore::None, None),
        Verdict::Foreign(Foreign::StoreUnrecorded)
    );
}

#[test]
fn the_write_counter_is_foreign_by_its_class_whatever_the_binding_says_it_is() {
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
    // Named even on a binding that calls itself the store: the class decides.
    let disguised = ReadBinding {
        class_name: Some("WriteCounter"),
        ..store(OWN)
    };
    assert_eq!(
        verdict(&[disguised]),
        Verdict::Foreign(Foreign::WriteCounter)
    );
    // And it is told first, beside any other.
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
    // With the serve-entry namespace not known, it is still foreign: any KV binding is.
    assert_eq!(
        check(Some(&[kv(SERVE)]), OwnStore::Recorded(OWN), None),
        Verdict::Foreign(Foreign::KvNamespace)
    );
    // A KV binding with no namespace never matches an unknown serve-entry namespace as `None == None`.
    let bare = ReadBinding {
        namespace_id: None,
        ..kv(SERVE)
    };
    assert_eq!(
        check(Some(&[bare]), OwnStore::Recorded(OWN), None),
        Verdict::Foreign(Foreign::KvNamespace)
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
        name: Some("X"),
        class_name: Some("Other"),
        ..ReadBinding::default()
    };
    assert_eq!(
        verdict(&[durable]),
        Verdict::Foreign(Foreign::DurableObject)
    );
}

#[test]
fn its_own_store_twice_is_foreign() {
    assert_eq!(
        verdict(&[store(OWN), store(OWN)]),
        Verdict::Foreign(Foreign::StoreTwice)
    );
}

#[test]
fn unknown_decides_nothing() {
    // No list.
    assert_eq!(
        check(None, OwnStore::Recorded(OWN), Some(SERVE)),
        Verdict::Unknown
    );
    // An entry with no type, or no name, makes the whole list unreadable, a foreign one beside it included.
    let no_type = ReadBinding {
        kind: None,
        ..store(OWN)
    };
    let no_name = ReadBinding {
        name: None,
        ..store(OWN)
    };
    assert_eq!(verdict(std::slice::from_ref(&no_type)), Verdict::Unknown);
    assert_eq!(verdict(&[no_name]), Verdict::Unknown);
    assert_eq!(verdict(&[store(OTHER), no_type]), Verdict::Unknown);
    // A store binding whose ID can't be read as one.
    for id in [
        None,
        Some("not-an-id"),
        Some("0123ABCD-4567-89EF-0123-456789ABCDEF"),
    ] {
        let unread = ReadBinding { id, ..store(OWN) };
        assert_eq!(verdict(&[unread]), Verdict::Unknown, "{id:?}");
    }
    // The room's record unreadable: its own store can't be told from another.
    assert_eq!(
        check(Some(&[store(OWN)]), OwnStore::Unreadable, Some(SERVE)),
        Verdict::Unknown
    );
    // But a binding read as foreign stays foreign beside one that can't be told.
    let unread = ReadBinding {
        id: None,
        ..store(OWN)
    };
    let service = ReadBinding {
        kind: Some("service"),
        name: Some("API"),
        ..ReadBinding::default()
    };
    assert_eq!(
        verdict(&[unread.clone(), service]),
        Verdict::Foreign(Foreign::Other)
    );
    // With the record unreadable, any store under `STORE` can't be told, but a database under another name can.
    assert_eq!(
        check(Some(&[unread, store(OTHER)]), OwnStore::Unreadable, None),
        Verdict::Unknown
    );
    let renamed = ReadBinding {
        name: Some("DB"),
        ..store(OTHER)
    };
    assert_eq!(
        check(Some(&[store(OTHER), renamed]), OwnStore::Unreadable, None),
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
        Foreign::DurableObject,
        Foreign::KvNamespace,
        Foreign::StoreTwice,
        Foreign::Other,
    ];
    let mut codes: Vec<&str> = all.iter().map(|f| f.code()).collect();
    for code in &codes {
        assert!((1..=64).contains(&code.len()));
        assert!(code.bytes().all(|b| b.is_ascii_lowercase() || b == b'_'));
    }
    codes.sort_unstable();
    codes.dedup();
    assert_eq!(codes.len(), all.len());
    assert_eq!(BINDING_FOREIGN, "script_binding_foreign");
    assert_eq!(BINDINGS_UNREAD, "script_bindings_unread");
}

fn record<'a>(name: &'a str) -> StoreRecord<'a> {
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
    // A create outstanding, with no ID: nothing is the app's own yet.
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
fn the_write_counter_class_is_the_one_the_content_worker_exports() {
    let source = include_str!("../../../apps/content/src/counter.ts");
    assert!(
        source.contains(&format!("export class {WRITE_COUNTER_CLASS} ")),
        "apps/content/src/counter.ts no longer exports a class named {WRITE_COUNTER_CLASS}"
    );
}
