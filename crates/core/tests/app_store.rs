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
/// The suffix the tests' store is named by. A store's suffix is 128 bits the room draws; any value names a store.
const SUFFIX: u128 = 0x0011_2233_4455_6677_8899_aabb_ccdd_eeff;

/// 32 lower-case hexadecimal digits for `n`, as a name's suffix is written.
fn digits(n: u128) -> String {
    format!("{n:032x}")
}

fn name() -> String {
    store_name(SUFFIX)
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
    let hex = digits(SUFFIX);
    assert_eq!(hex, "00112233445566778899aabbccddeeff");
    assert_eq!(name(), format!("podster-store-{hex}"));
    assert!(is_store_name(&name()));
    // Every value names a store of the form: leading zeros are written, and the largest value fits.
    assert_eq!(store_name(0), format!("podster-store-{}", "0".repeat(32)));
    assert_eq!(store_name(1), format!("podster-store-{}1", "0".repeat(31)));
    assert_eq!(
        store_name(u128::MAX),
        format!("podster-store-{}", "f".repeat(32))
    );
    for n in [0, 1, 0xa, 1 << 64, SUFFIX, u128::MAX] {
        assert!(is_store_name(&store_name(n)), "{n}");
    }
    assert_ne!(store_name(1), store_name(2));
    for bad in [
        format!("podster-store-{}", &hex[1..]),
        format!("podster-store-{hex}0"),
        format!("podster-store-{}", hex.to_uppercase()),
        format!("podster-store-{}g", &hex[1..]),
        format!("Podster-store-{hex}"),
        format!("podster-stores-{hex}"),
        format!("x-podster-store-{hex}"),
        format!("podster-store-{}-", &hex[1..]),
        hex.clone(),
        "podster-store-".to_string(),
        String::new(),
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
    let other = store_name(SUFFIX + 1);
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
    let other = store_name(SUFFIX + 1);
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

/// A page of these databases, each named by its own ID, so names are as distinct as IDs.
fn page(ids: &[String], total: u64) -> ListPage<'_> {
    ListPage {
        envelope: ok(),
        entries: Some(
            ids.iter()
                .map(|id| Described {
                    id: Some(id),
                    name: Some(id),
                })
                .collect(),
        ),
        total: Some(total),
    }
}

#[test]
fn a_list_is_whole_only_when_its_pages_add_up() {
    // Empty.
    let mut list = ListRead::default();
    assert_eq!(list.take(&page(&[], 0)), ListStep::Done);
    assert!(list.found.is_empty());
    // A page taken after the list was whole doesn't count, even one that would.
    assert_eq!(list.take(&page(&[], 0)), ListStep::Unknown);
    // One short page.
    let a = ids(3, 0);
    let mut list = ListRead::default();
    assert_eq!(list.take(&page(&a, 3)), ListStep::Done);
    assert_eq!(list.found.len(), 3);
    assert_eq!(list.found[0], (a[0].clone(), a[0].clone()));
    // A full page, then the rest.
    let full = ids(LIST_PAGE, 0);
    let rest = ids(2, LIST_PAGE);
    let total = (LIST_PAGE + 2) as u64;
    let mut list = ListRead::default();
    assert_eq!(list.take(&page(&full, total)), ListStep::More);
    assert_eq!(list.take(&page(&rest, total)), ListStep::Done);
    assert_eq!(list.found.len(), LIST_PAGE + 2);
    // Exactly one full page.
    let mut list = ListRead::default();
    assert_eq!(list.take(&page(&full, LIST_PAGE as u64)), ListStep::Done);
}

#[test]
fn a_list_of_any_other_shape_is_no_list() {
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
            ..page(&a, 3)
        }),
        ListStep::Unknown
    );
    assert_eq!(
        one(ListPage {
            envelope: Envelope {
                success: None,
                ..ok()
            },
            ..page(&a, 3)
        }),
        ListStep::Unknown
    );
    assert_eq!(
        one(ListPage {
            entries: None,
            ..page(&a, 3)
        }),
        ListStep::Unknown
    );
    assert_eq!(
        one(ListPage {
            total: None,
            ..page(&a, 3)
        }),
        ListStep::Unknown
    );
    // More than a page's worth in one page.
    assert_eq!(one(page(&over, (LIST_PAGE + 1) as u64)), ListStep::Unknown);
    // A page longer than the total, or a short page before the end.
    assert_eq!(one(page(&a, 2)), ListStep::Unknown);
    assert_eq!(one(page(&a, 4)), ListStep::Unknown);
    // An entry without an ID of D1's form, or without a name.
    let mut bad = page(&a, 3);
    bad.entries.as_mut().unwrap()[1].id = Some("not-a-uuid");
    assert_eq!(one(bad), ListStep::Unknown);
    let mut bad = page(&a, 3);
    bad.entries.as_mut().unwrap()[2].name = None;
    assert_eq!(one(bad), ListStep::Unknown);
    let mut bad = page(&a, 3);
    bad.entries.as_mut().unwrap()[0].id = None;
    assert_eq!(one(bad), ListStep::Unknown);
    // The total changes between pages.
    let rest = ids(2, LIST_PAGE);
    let mut list = ListRead::default();
    assert_eq!(
        list.take(&page(&full, (LIST_PAGE + 2) as u64)),
        ListStep::More
    );
    assert_eq!(
        list.take(&page(&rest, (LIST_PAGE + 3) as u64)),
        ListStep::Unknown
    );
    // The total grows between two full pages, which would otherwise read as more to come.
    let next = ids(LIST_PAGE, LIST_PAGE);
    let mut list = ListRead::default();
    assert_eq!(
        list.take(&page(&full, (3 * LIST_PAGE) as u64)),
        ListStep::More
    );
    assert_eq!(
        list.take(&page(&next, (4 * LIST_PAGE) as u64)),
        ListStep::Unknown
    );
    // A second page that runs past the total.
    let mut list = ListRead::default();
    assert_eq!(
        list.take(&page(&full, (LIST_PAGE + 1) as u64)),
        ListStep::More
    );
    assert_eq!(
        list.take(&page(&rest, (LIST_PAGE + 1) as u64)),
        ListStep::Unknown
    );
}

#[test]
fn a_list_longer_than_its_bound_is_no_list() {
    let pages: Vec<Vec<String>> = (0..=MAX_LIST_PAGES)
        .map(|at| ids(LIST_PAGE, at * LIST_PAGE))
        .collect();
    let total = (LIST_PAGE * MAX_LIST_PAGES + 1) as u64;
    let mut list = ListRead::default();
    for at in 1..MAX_LIST_PAGES {
        assert_eq!(
            list.take(&page(&pages[at - 1], total)),
            ListStep::More,
            "page {at}"
        );
    }
    assert_eq!(
        list.take(&page(&pages[MAX_LIST_PAGES - 1], total)),
        ListStep::Unknown
    );
    // At exactly the bound, the list is whole.
    let total = (LIST_PAGE * MAX_LIST_PAGES) as u64;
    let mut list = ListRead::default();
    for at in 1..MAX_LIST_PAGES {
        assert_eq!(list.take(&page(&pages[at - 1], total)), ListStep::More);
    }
    assert_eq!(
        list.take(&page(&pages[MAX_LIST_PAGES - 1], total)),
        ListStep::Done
    );
    assert_eq!(list.found.len(), LIST_PAGE * MAX_LIST_PAGES);
    // And a page past the bound is never read as more.
    assert_eq!(
        list.take(&page(&pages[MAX_LIST_PAGES], total)),
        ListStep::Unknown
    );
    // Past the bound, a page that would make the list whole still isn't taken.
    let total = (LIST_PAGE * MAX_LIST_PAGES + 1) as u64;
    let last = ids(1, MAX_LIST_PAGES * LIST_PAGE);
    let mut list = ListRead::default();
    for at in 1..=MAX_LIST_PAGES {
        let want = if at < MAX_LIST_PAGES {
            ListStep::More
        } else {
            ListStep::Unknown
        };
        assert_eq!(list.take(&page(&pages[at - 1], total)), want, "page {at}");
    }
    assert_eq!(list.take(&page(&last, total)), ListStep::Unknown);
}

#[test]
fn nothing_taken_after_an_unknown_page_counts() {
    let full = ids(LIST_PAGE, 0);
    let rest = ids(2, LIST_PAGE);
    let total = (LIST_PAGE + 2) as u64;
    let mut list = ListRead::default();
    assert_eq!(
        list.take(&ListPage {
            total: None,
            ..page(&full, total)
        }),
        ListStep::Unknown
    );
    // The page that failed added nothing, and the next, which would have been the first, isn't taken.
    assert_eq!(list.take(&page(&full, total)), ListStep::Unknown);
    assert_eq!(list.take(&page(&rest, total)), ListStep::Unknown);
    assert!(list.found.is_empty());
}

#[test]
fn an_id_or_a_name_seen_twice_is_no_list() {
    // Offset paging with one database deleted and one made between two pages: the total holds, and the second page
    // starts one entry early, so the first page's last entry comes again and the newest is never seen.
    let first = ids(LIST_PAGE, 0);
    let mut second = ids(LIST_PAGE - 1, LIST_PAGE);
    second.insert(0, first[LIST_PAGE - 1].clone());
    let total = (2 * LIST_PAGE) as u64;
    let mut list = ListRead::default();
    assert_eq!(list.take(&page(&first, total)), ListStep::More);
    assert_eq!(list.take(&page(&second, total)), ListStep::Unknown);
    // The control: the same two pages with no repeat are whole.
    let mut list = ListRead::default();
    assert_eq!(list.take(&page(&first, total)), ListStep::More);
    assert_eq!(
        list.take(&page(&ids(LIST_PAGE, LIST_PAGE), total)),
        ListStep::Done
    );
    // A repeat within one page.
    let mut twice = ids(3, 0);
    twice[2] = twice[0].clone();
    assert_eq!(
        ListRead::default().take(&page(&twice, 3)),
        ListStep::Unknown
    );
    // Another ID under a name already seen, on a later page.
    let other = ids(1, LIST_PAGE);
    let mut list = ListRead::default();
    assert_eq!(
        list.take(&page(&first, (LIST_PAGE + 1) as u64)),
        ListStep::More
    );
    let renamed = ListPage {
        entries: Some(vec![Described {
            id: Some(&other[0]),
            name: Some(&first[0]),
        }]),
        ..page(&other, (LIST_PAGE + 1) as u64)
    };
    assert_eq!(list.take(&renamed), ListStep::Unknown);
    // Two IDs under one name on one page, and the control, two names.
    let a = ids(2, 0);
    let named = |second: &'static str| ListPage {
        entries: Some(vec![
            Described {
                id: Some(&a[0]),
                name: Some("db"),
            },
            Described {
                id: Some(&a[1]),
                name: Some(second),
            },
        ]),
        ..page(&a, 2)
    };
    assert_eq!(ListRead::default().take(&named("db")), ListStep::Unknown);
    // One ID under two names, on one page.
    let renamed_twice = ListPage {
        entries: Some(vec![
            Described {
                id: Some(&a[0]),
                name: Some("db"),
            },
            Described {
                id: Some(&a[0]),
                name: Some("db2"),
            },
        ]),
        ..page(&a, 2)
    };
    assert_eq!(ListRead::default().take(&renamed_twice), ListStep::Unknown);
    assert_eq!(ListRead::default().take(&named("db2")), ListStep::Done);
}
