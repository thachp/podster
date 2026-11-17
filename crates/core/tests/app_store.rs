#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]
//! A room's app store (M6 stage 1): names and IDs, rule 3(a)'s binding from the room's record alone, and the strict
//! reading of what D1's API answers. Each refusal is shown against an answer one change away that is accepted, so no
//! assertion passes whatever the rule does (review standard 2).

use podster_core::app_store::*;

const ID: &str = "0123abcd-4567-89ef-0123-456789abcdef";
const NONCE: &str = "00112233445566778899aabbccddeeff";

fn name() -> String {
    store_name(NONCE).unwrap()
}

#[test]
fn kinds_are_exactly_d1() {
    assert_eq!(STORE_KINDS, &["d1"]);
    assert_eq!(StoreKind::parse("d1"), Some(StoreKind::D1));
    assert_eq!(StoreKind::D1.as_str(), "d1");
    for other in ["D1", "kv", "", "d1 ", " d1", "d2"] {
        assert_eq!(StoreKind::parse(other), None, "{other:?}");
    }
}

#[test]
fn a_store_name_is_the_prefix_and_32_lower_hex_digits() {
    assert_eq!(name(), format!("podster-store-{NONCE}"));
    assert!(is_store_name(&name()));
    assert_eq!(store_name(&NONCE[1..]), None);
    assert_eq!(store_name(&format!("{NONCE}0")), None);
    assert_eq!(store_name(&NONCE.to_uppercase()), None);
    assert_eq!(store_name(&format!("{}g", &NONCE[1..])), None);
    assert_eq!(store_name(""), None);
    for bad in [
        format!("podster-store-{}", &NONCE[1..]),
        format!("podster-store-{NONCE}0"),
        format!("podster-store-{}", NONCE.to_uppercase()),
        format!("Podster-store-{NONCE}"),
        format!("podster-stores-{NONCE}"),
        format!("x-podster-store-{NONCE}"),
        format!("podster-store-{}-", &NONCE[1..]),
        NONCE.to_string(),
        "podster-store-".to_string(),
    ] {
        assert!(!is_store_name(&bad), "{bad}");
    }
}

#[test]
fn a_d1_id_is_a_lower_case_uuid() {
    assert!(d1_id_form(ID));
    assert!(store_id_form(StoreKind::D1, ID));
    for bad in [
        ID.to_uppercase(),
        ID.replace('-', ""),
        format!("{ID}0"),
        ID[1..].to_string(),
        ID.replacen('-', "x", 1),
        "0123abcd-4567-89ef-0123-456789abcdeg".to_string(),
        "0123abcd4-567-89ef-0123-456789abcdef".to_string(),
        "0123abcd-456789ef--0123-456789abcdef".to_string(),
        String::new(),
    ] {
        assert!(!d1_id_form(&bad), "{bad}");
    }
}

fn made<'a>(name: &'a str) -> StoreRecord<'a> {
    StoreRecord {
        kind: Some("d1"),
        name: Some(name),
        id: Some(ID),
        made_at: Some(10),
        delete_owed_at: None,
        gone_at: None,
    }
}

#[test]
fn rule_3a_binds_only_a_made_store_from_a_whole_record() {
    let n = name();
    assert_eq!(
        binding(Some(&made(&n))),
        Ok(Binding {
            kind: StoreKind::D1,
            id: ID.to_string()
        })
    );
    assert_eq!(binding(None), Err(NoBinding::NoStore));
    let asked = StoreRecord {
        id: None,
        made_at: None,
        ..made(&n)
    };
    assert_eq!(binding(Some(&asked)), Err(NoBinding::NotMade));
    let owed = StoreRecord {
        delete_owed_at: Some(20),
        ..made(&n)
    };
    assert_eq!(binding(Some(&owed)), Err(NoBinding::DeleteOwed));
    let gone = StoreRecord {
        delete_owed_at: Some(20),
        gone_at: Some(30),
        ..made(&n)
    };
    assert_eq!(binding(Some(&gone)), Err(NoBinding::DeleteOwed));
    let owed_unmade = StoreRecord {
        delete_owed_at: Some(20),
        ..asked.clone()
    };
    assert_eq!(binding(Some(&owed_unmade)), Err(NoBinding::DeleteOwed));
}

#[test]
fn rule_3a_binds_nothing_from_a_malformed_record() {
    let n = name();
    let upper = ID.to_uppercase();
    let foreign = "kv-namespace".to_string();
    let cases: Vec<(&str, StoreRecord)> = vec![
        (
            "no kind",
            StoreRecord {
                kind: None,
                ..made(&n)
            },
        ),
        (
            "an unknown kind",
            StoreRecord {
                kind: Some("kv"),
                ..made(&n)
            },
        ),
        (
            "a kind's case twin",
            StoreRecord {
                kind: Some("D1"),
                ..made(&n)
            },
        ),
        (
            "no name",
            StoreRecord {
                name: None,
                ..made(&n)
            },
        ),
        (
            "a name not a store's",
            StoreRecord {
                name: Some(&foreign),
                ..made(&n)
            },
        ),
        (
            "an ID with no time made",
            StoreRecord {
                made_at: None,
                ..made(&n)
            },
        ),
        (
            "a time made with no ID",
            StoreRecord {
                id: None,
                ..made(&n)
            },
        ),
        (
            "an ID not of its kind's form",
            StoreRecord {
                id: Some(&upper),
                ..made(&n)
            },
        ),
        (
            "gone with no deletion owed",
            StoreRecord {
                gone_at: Some(5),
                ..made(&n)
            },
        ),
        // Malformed wins over owed: an owed record that is malformed says so.
        (
            "owed and an ID not of its form",
            StoreRecord {
                id: Some(&upper),
                delete_owed_at: Some(9),
                ..made(&n)
            },
        ),
    ];
    for (why, record) in cases {
        assert_eq!(binding(Some(&record)), Err(NoBinding::Malformed), "{why}");
    }
}

#[test]
fn each_refusal_has_its_code() {
    assert_eq!(
        [
            NoBinding::NoStore,
            NoBinding::NotMade,
            NoBinding::DeleteOwed,
            NoBinding::Malformed
        ]
        .map(NoBinding::code),
        [
            "store_none",
            "store_not_made",
            "store_delete_owed",
            "store_record_malformed"
        ]
    );
}

fn ok() -> Envelope {
    Envelope {
        status: 200,
        success: Some(true),
        errors: Some(vec![]),
    }
}

fn not_found() -> Envelope {
    Envelope {
        status: 404,
        success: Some(false),
        errors: Some(vec![D1_NOT_FOUND]),
    }
}

#[test]
fn a_create_counts_only_when_it_names_exactly_what_was_asked() {
    let n = name();
    let said = Described {
        id: Some(ID),
        name: Some(&n),
    };
    assert_eq!(created(&ok(), &said, &n), Some(ID.to_string()));
    // The envelope: only 200 and success true.
    for status in [201, 202, 204, 299, 400, 404, 500] {
        assert_eq!(
            created(&Envelope { status, ..ok() }, &said, &n),
            None,
            "{status}"
        );
    }
    assert_eq!(
        created(
            &Envelope {
                success: None,
                ..ok()
            },
            &said,
            &n
        ),
        None
    );
    assert_eq!(
        created(
            &Envelope {
                success: Some(false),
                ..ok()
            },
            &said,
            &n
        ),
        None
    );
    // The description: this name, and an ID of D1's form.
    let other = store_name("ffeeddccbbaa99887766554433221100").unwrap();
    assert_eq!(
        created(
            &ok(),
            &Described {
                name: Some(&other),
                ..said.clone()
            },
            &n
        ),
        None
    );
    assert_eq!(
        created(
            &ok(),
            &Described {
                name: None,
                ..said.clone()
            },
            &n
        ),
        None
    );
    assert_eq!(
        created(
            &ok(),
            &Described {
                id: None,
                ..said.clone()
            },
            &n
        ),
        None
    );
    let upper = ID.to_uppercase();
    assert_eq!(
        created(
            &ok(),
            &Described {
                id: Some(&upper),
                ..said.clone()
            },
            &n
        ),
        None
    );
    // Asked for a name that isn't a store's: never counted, whatever came back.
    let foreign = "anything";
    assert_eq!(
        created(
            &ok(),
            &Described {
                name: Some(foreign),
                ..said.clone()
            },
            foreign
        ),
        None
    );
}

#[test]
fn a_read_is_present_only_for_this_id_and_name_and_gone_only_on_d1s_not_found() {
    let n = name();
    let said = Described {
        id: Some(ID),
        name: Some(&n),
    };
    assert_eq!(read(&ok(), &said, ID, &n), StoreRead::Present);
    assert_eq!(
        read(&not_found(), &Described::default(), ID, &n),
        StoreRead::Gone
    );
    // Present needs the envelope, the ID and the name.
    assert_eq!(
        read(
            &Envelope {
                status: 201,
                ..ok()
            },
            &said,
            ID,
            &n
        ),
        StoreRead::Unknown
    );
    assert_eq!(
        read(
            &Envelope {
                success: None,
                ..ok()
            },
            &said,
            ID,
            &n
        ),
        StoreRead::Unknown
    );
    let other_id = "0123abcd-4567-89ef-0123-456789abcdee";
    assert_eq!(
        read(
            &ok(),
            &Described {
                id: Some(other_id),
                ..said.clone()
            },
            ID,
            &n
        ),
        StoreRead::Unknown
    );
    let other = store_name("ffeeddccbbaa99887766554433221100").unwrap();
    assert_eq!(
        read(
            &ok(),
            &Described {
                name: Some(&other),
                ..said.clone()
            },
            ID,
            &n
        ),
        StoreRead::Unknown
    );
    assert_eq!(
        read(&ok(), &Described::default(), ID, &n),
        StoreRead::Unknown
    );
    // Gone needs 404, success false, and exactly D1's one code.
    assert_eq!(
        read(
            &Envelope {
                status: 410,
                ..not_found()
            },
            &Described::default(),
            ID,
            &n
        ),
        StoreRead::Unknown
    );
    assert_eq!(
        read(
            &Envelope {
                status: 400,
                ..not_found()
            },
            &Described::default(),
            ID,
            &n
        ),
        StoreRead::Unknown
    );
    assert_eq!(
        read(
            &Envelope {
                success: None,
                ..not_found()
            },
            &Described::default(),
            ID,
            &n
        ),
        StoreRead::Unknown
    );
    assert_eq!(
        read(
            &Envelope {
                success: Some(true),
                ..not_found()
            },
            &Described::default(),
            ID,
            &n
        ),
        StoreRead::Unknown
    );
    for errors in [
        None,
        Some(vec![]),
        Some(vec![10013]),
        Some(vec![7403]),
        Some(vec![D1_NOT_FOUND, 1000]),
        Some(vec![1000, D1_NOT_FOUND]),
        Some(vec![D1_NOT_FOUND, D1_NOT_FOUND]),
    ] {
        assert_eq!(
            read(
                &Envelope {
                    errors: errors.clone(),
                    ..not_found()
                },
                &Described::default(),
                ID,
                &n
            ),
            StoreRead::Unknown,
            "{errors:?}"
        );
    }
    // Asked about an ID or a name that isn't of its form: unknown, whatever came back.
    let upper = ID.to_uppercase();
    assert_eq!(
        read(&not_found(), &Described::default(), &upper, &n),
        StoreRead::Unknown
    );
    assert_eq!(
        read(&not_found(), &Described::default(), ID, "anything"),
        StoreRead::Unknown
    );
}

fn ids(n: usize, from: usize) -> Vec<String> {
    (from..from + n)
        .map(|i| format!("00000000-0000-0000-0000-{i:012x}"))
        .collect()
}

fn page<'a>(ids: &'a [String], names: &'a [String], total: u64) -> ListPage<'a> {
    ListPage {
        envelope: ok(),
        entries: Some(
            ids.iter()
                .zip(names)
                .map(|(id, name)| Described {
                    id: Some(id),
                    name: Some(name),
                })
                .collect(),
        ),
        total: Some(total),
    }
}

fn names(n: usize) -> Vec<String> {
    (0..n).map(|i| format!("db-{i}")).collect()
}

#[test]
fn a_list_is_whole_only_when_its_pages_add_up() {
    let names = names(LIST_PAGE);
    // Empty.
    let mut list = ListRead::default();
    assert_eq!(list.take(&page(&[], &[], 0)), ListStep::Done);
    assert!(list.found.is_empty());
    // A page taken after the list was whole doesn't count, even one that would.
    assert_eq!(list.take(&page(&[], &[], 0)), ListStep::Unknown);
    // One short page.
    let a = ids(3, 0);
    let mut list = ListRead::default();
    assert_eq!(list.take(&page(&a, &names, 3)), ListStep::Done);
    assert_eq!(list.found.len(), 3);
    assert_eq!(list.found[0], (a[0].clone(), "db-0".to_string()));
    // A full page, then the rest.
    let full = ids(LIST_PAGE, 0);
    let rest = ids(2, LIST_PAGE);
    let total = (LIST_PAGE + 2) as u64;
    let mut list = ListRead::default();
    assert_eq!(list.take(&page(&full, &names, total)), ListStep::More);
    assert_eq!(list.take(&page(&rest, &names, total)), ListStep::Done);
    assert_eq!(list.found.len(), LIST_PAGE + 2);
    // Exactly one full page.
    let mut list = ListRead::default();
    assert_eq!(
        list.take(&page(&full, &names, LIST_PAGE as u64)),
        ListStep::Done
    );
}

#[test]
fn a_list_of_any_other_shape_is_no_list() {
    let names = names(LIST_PAGE + 1);
    let a = ids(3, 0);
    let full = ids(LIST_PAGE, 0);
    let over = ids(LIST_PAGE + 1, 0);
    let one = |p: ListPage| ListRead::default().take(&p);
    assert_eq!(
        one(ListPage {
            envelope: Envelope {
                status: 201,
                ..ok()
            },
            ..page(&a, &names, 3)
        }),
        ListStep::Unknown
    );
    assert_eq!(
        one(ListPage {
            envelope: Envelope {
                success: None,
                ..ok()
            },
            ..page(&a, &names, 3)
        }),
        ListStep::Unknown
    );
    assert_eq!(
        one(ListPage {
            entries: None,
            ..page(&a, &names, 3)
        }),
        ListStep::Unknown
    );
    assert_eq!(
        one(ListPage {
            total: None,
            ..page(&a, &names, 3)
        }),
        ListStep::Unknown
    );
    // More than a page's worth in one page.
    assert_eq!(
        one(page(&over, &names, (LIST_PAGE + 1) as u64)),
        ListStep::Unknown
    );
    // A page longer than the total, or a short page before the end.
    assert_eq!(one(page(&a, &names, 2)), ListStep::Unknown);
    assert_eq!(one(page(&a, &names, 4)), ListStep::Unknown);
    // An entry without an ID of D1's form, or without a name.
    let mut bad = page(&a, &names, 3);
    bad.entries.as_mut().unwrap()[1].id = Some("not-a-uuid");
    assert_eq!(one(bad), ListStep::Unknown);
    let mut bad = page(&a, &names, 3);
    bad.entries.as_mut().unwrap()[2].name = None;
    assert_eq!(one(bad), ListStep::Unknown);
    let mut bad = page(&a, &names, 3);
    bad.entries.as_mut().unwrap()[0].id = None;
    assert_eq!(one(bad), ListStep::Unknown);
    // The total changes between pages.
    let rest = ids(2, LIST_PAGE);
    let mut list = ListRead::default();
    assert_eq!(
        list.take(&page(&full, &names, (LIST_PAGE + 2) as u64)),
        ListStep::More
    );
    assert_eq!(
        list.take(&page(&rest, &names, (LIST_PAGE + 3) as u64)),
        ListStep::Unknown
    );
    // The total grows between two full pages, which would otherwise read as more to come.
    let next = ids(LIST_PAGE, LIST_PAGE);
    let mut list = ListRead::default();
    assert_eq!(
        list.take(&page(&full, &names, (3 * LIST_PAGE) as u64)),
        ListStep::More
    );
    assert_eq!(
        list.take(&page(&next, &names, (4 * LIST_PAGE) as u64)),
        ListStep::Unknown
    );
    // A second page that runs past the total.
    let mut list = ListRead::default();
    assert_eq!(
        list.take(&page(&full, &names, (LIST_PAGE + 1) as u64)),
        ListStep::More
    );
    assert_eq!(
        list.take(&page(&rest, &names, (LIST_PAGE + 1) as u64)),
        ListStep::Unknown
    );
}

#[test]
fn a_list_longer_than_its_bound_is_no_list() {
    let names = names(LIST_PAGE);
    let full = ids(LIST_PAGE, 0);
    let total = (LIST_PAGE * MAX_LIST_PAGES + 1) as u64;
    let mut list = ListRead::default();
    for at in 1..MAX_LIST_PAGES {
        assert_eq!(
            list.take(&page(&full, &names, total)),
            ListStep::More,
            "page {at}"
        );
    }
    assert_eq!(list.take(&page(&full, &names, total)), ListStep::Unknown);
    // At exactly the bound, the list is whole.
    let total = (LIST_PAGE * MAX_LIST_PAGES) as u64;
    let mut list = ListRead::default();
    for _ in 1..MAX_LIST_PAGES {
        assert_eq!(list.take(&page(&full, &names, total)), ListStep::More);
    }
    assert_eq!(list.take(&page(&full, &names, total)), ListStep::Done);
    // And a page past the bound is never read as more.
    assert_eq!(list.take(&page(&full, &names, total)), ListStep::Unknown);
    // Past the bound, a page that would make the list whole still isn't taken.
    let total = (LIST_PAGE * MAX_LIST_PAGES + 1) as u64;
    let last = ids(1, 0);
    let mut list = ListRead::default();
    for _ in 1..MAX_LIST_PAGES {
        assert_eq!(list.take(&page(&full, &names, total)), ListStep::More);
    }
    assert_eq!(list.take(&page(&full, &names, total)), ListStep::Unknown);
    assert_eq!(list.take(&page(&last, &names, total)), ListStep::Unknown);
}

#[test]
fn nothing_taken_after_an_unknown_page_counts() {
    let names = names(LIST_PAGE);
    let full = ids(LIST_PAGE, 0);
    let rest = ids(2, LIST_PAGE);
    let total = (LIST_PAGE + 2) as u64;
    let mut list = ListRead::default();
    assert_eq!(
        list.take(&ListPage {
            total: None,
            ..page(&full, &names, total)
        }),
        ListStep::Unknown
    );
    // The page that failed added nothing, and the next, which would have been the first, isn't taken.
    assert_eq!(list.take(&page(&full, &names, total)), ListStep::Unknown);
    assert_eq!(list.take(&page(&rest, &names, total)), ListStep::Unknown);
    assert!(list.found.is_empty());
}
