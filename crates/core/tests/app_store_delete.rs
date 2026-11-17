#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]
//! Deleting an app's data (M6 stage 1, S4 of the store plan): what a command owes, what the job does next, and when a
//! store counts as gone. **Gone only on D1's own not-found, read twice at least ten minutes apart,** and for a record
//! with a name and no ID only after a whole list by its name. Each edge is shown to the millisecond, beside the answer
//! one step away (review standards 1 and 2).

use podster_core::app_store::*;

const ID: &str = "0123abcd-4567-89ef-0123-456789abcdef";
const AT: i64 = 1_900_000_000_000;
const SPAN: i64 = GONE_SPAN_MS;

fn name() -> String {
    store_name(0x0011_2233_4455_6677_8899_aabb_ccdd_eeff)
}

fn record<'a>(name: &'a str, id: Option<&'a str>, owed: Option<i64>) -> StoreRecord<'a> {
    StoreRecord {
        kind: Some("d1"),
        name: Some(name),
        id,
        made_at: id.map(|_| AT - 1),
        delete_owed_at: owed,
        gone_at: None,
    }
}

#[test]
fn the_notice_is_the_owners_words_exactly() {
    assert_eq!(
        DATA_DELETED_NOTICE,
        "Your app’s data is deleted now, and nothing can read it. Cloudflare keeps a recoverable copy for up to 7 days; after that it’s gone for good."
    );
}

#[test]
fn the_causes_are_a_closed_set_of_the_columns_form() {
    let codes: Vec<&str> = DeleteCause::ALL.iter().map(|cause| cause.code()).collect();
    assert_eq!(
        codes,
        [
            "operator_takedown",
            "owner_deleted",
            "label_retired",
            "room_deleted"
        ]
    );
    for cause in DeleteCause::ALL {
        assert_eq!(DeleteCause::parse(cause.code()), Some(cause));
        // The room's column takes lower-case letters and `_`, 1 to 64 of them.
        assert!(cause
            .code()
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b == b'_'));
    }
    for other in [
        "",
        "Operator_takedown",
        "operator-takedown",
        "owner",
        "gone",
    ] {
        assert_eq!(DeleteCause::parse(other), None, "{other}");
    }
}

#[test]
fn a_command_owes_once_and_asking_again_changes_nothing() {
    let n = name();
    assert_eq!(owe(None), Owe::NoStore);
    // Made, a create outstanding, and a record not of the room's form: each is owed.
    assert_eq!(owe(Some(&record(&n, Some(ID), None))), Owe::Owe);
    assert_eq!(owe(Some(&record(&n, None, None))), Owe::Owe);
    let odd = StoreRecord {
        kind: Some("kv"),
        ..record(&n, Some(ID), None)
    };
    assert_eq!(owe(Some(&odd)), Owe::Owe);
    // Owed, or gone: never again.
    assert_eq!(owe(Some(&record(&n, Some(ID), Some(AT)))), Owe::Owed);
    let gone = StoreRecord {
        gone_at: Some(AT + 1),
        ..record(&n, Some(ID), Some(AT))
    };
    assert_eq!(owe(Some(&gone)), Owe::Owed);
    // And the answer says which.
    assert_eq!(data_state(None), DataState::None);
    assert_eq!(
        data_state(Some(&record(&n, Some(ID), Some(AT)))),
        DataState::Deleting
    );
    assert_eq!(data_state(Some(&gone)), DataState::Deleted);
    assert_eq!(
        [DataState::None, DataState::Deleting, DataState::Deleted].map(DataState::code),
        ["none", "deleting", "deleted"]
    );
    // Once owed, nothing is bound to it: rule 3(a) refuses it.
    assert_eq!(
        binding(Some(&record(&n, Some(ID), Some(AT)))),
        Err(NoBinding::DeleteOwed)
    );
}

#[test]
fn the_job_deletes_only_a_record_owed_by_its_id_or_lists_by_its_name() {
    let n = name();
    assert_eq!(delete_step(None, None), DeleteStep::Nothing);
    // Owed nothing: the app's live data is never touched.
    assert_eq!(
        delete_step(Some(&record(&n, Some(ID), None)), None),
        DeleteStep::Nothing
    );
    // Owed: deleted by its ID, then, once D1 said gone, read only.
    let owed = record(&n, Some(ID), Some(AT));
    assert_eq!(
        delete_step(Some(&owed), None),
        DeleteStep::Delete(ID.to_owned())
    );
    assert_eq!(
        delete_step(Some(&owed), Some(AT)),
        DeleteStep::Read(ID.to_owned())
    );
    // A name and no ID: listed by the name first, never guessed.
    assert_eq!(
        delete_step(Some(&record(&n, None, Some(AT))), None),
        DeleteStep::List
    );
    assert_eq!(
        delete_step(Some(&record(&n, None, Some(AT))), Some(AT)),
        DeleteStep::List
    );
    // Gone: nothing more.
    let gone = StoreRecord {
        gone_at: Some(AT),
        ..owed.clone()
    };
    assert_eq!(delete_step(Some(&gone), Some(AT)), DeleteStep::Nothing);
    // Anything not of the room's form sends nothing.
    let upper = ID.to_uppercase();
    for bad in [
        StoreRecord {
            kind: Some("kv"),
            ..owed.clone()
        },
        StoreRecord {
            kind: None,
            ..owed.clone()
        },
        StoreRecord {
            name: Some("my-database"),
            ..owed.clone()
        },
        StoreRecord {
            name: None,
            ..owed.clone()
        },
        StoreRecord {
            id: Some(&upper),
            ..owed.clone()
        },
        StoreRecord {
            id: Some("../../workers/scripts"),
            ..owed.clone()
        },
    ] {
        assert_eq!(
            delete_step(Some(&bad), None),
            DeleteStep::Malformed,
            "{bad:?}"
        );
    }
}

#[test]
fn a_store_is_gone_only_on_two_reads_of_d1s_not_found_ten_minutes_apart() {
    assert_eq!(SPAN, 600_000);
    // The first: noted, read again ten minutes on.
    assert_eq!(
        after_read(StoreRead::Gone, None, AT),
        DeleteOutcome::NoteGone { at: AT + SPAN }
    );
    // A second within ten minutes counts for nothing, to the millisecond.
    assert_eq!(
        after_read(StoreRead::Gone, Some(AT), AT + SPAN - 1),
        DeleteOutcome::WaitGone { at: AT + SPAN }
    );
    // Ten minutes after the first: gone.
    assert_eq!(
        after_read(StoreRead::Gone, Some(AT), AT + SPAN),
        DeleteOutcome::Gone
    );
    // Present: still there, whatever was noted.
    assert_eq!(
        after_read(StoreRead::Present, Some(AT), AT + SPAN),
        DeleteOutcome::Present
    );
    // Anything that isn't D1's own answer decides nothing, never gone.
    for first in [None, Some(AT)] {
        assert_eq!(
            after_read(StoreRead::Unknown, first, AT + 5 * SPAN),
            DeleteOutcome::Unknown
        );
    }
}

#[test]
fn a_name_with_no_id_is_resolved_by_a_whole_list_before_anything_is_decided() {
    let n = name();
    let other = store_name(7);
    let found = vec![
        (
            "aaaaaaaa-0000-0000-0000-000000000000".to_owned(),
            other.clone(),
        ),
        (ID.to_owned(), n.clone()),
    ];
    let without = vec![("aaaaaaaa-0000-0000-0000-000000000000".to_owned(), other)];
    // Listed: found by its name, at any time, whatever was noted.
    for (sent, first, now) in [(Some(AT), None, AT), (None, Some(AT), AT + 3 * SPAN)] {
        assert_eq!(
            after_list(Some(&found), &n, sent, first, now),
            DeleteOutcome::Found(ID.to_owned())
        );
    }
    // No whole list decides nothing.
    assert_eq!(
        after_list(None, &n, None, Some(AT), AT + 5 * SPAN),
        DeleteOutcome::Unknown
    );
    // A create still outstanding: a list without it counts only from ten minutes after the create.
    assert_eq!(
        after_list(Some(&without), &n, Some(AT), None, AT + SPAN - 1),
        DeleteOutcome::TooSoon { at: AT + SPAN }
    );
    assert_eq!(
        after_list(Some(&without), &n, Some(AT), None, AT + SPAN),
        DeleteOutcome::NoteGone { at: AT + 2 * SPAN }
    );
    // A note from before that is no first: noted again.
    assert_eq!(
        after_list(
            Some(&without),
            &n,
            Some(AT),
            Some(AT + SPAN - 1),
            AT + 3 * SPAN
        ),
        DeleteOutcome::NoteGone { at: AT + 4 * SPAN }
    );
    // A second ten minutes after the first: it was never made, or is gone.
    assert_eq!(
        after_list(
            Some(&without),
            &n,
            Some(AT),
            Some(AT + SPAN),
            AT + 2 * SPAN - 1
        ),
        DeleteOutcome::WaitGone { at: AT + 2 * SPAN }
    );
    assert_eq!(
        after_list(Some(&without), &n, Some(AT), Some(AT + SPAN), AT + 2 * SPAN),
        DeleteOutcome::Gone
    );
    // A create settled as having made nothing: counts at once.
    assert_eq!(
        after_list(Some(&without), &n, None, None, AT),
        DeleteOutcome::NoteGone { at: AT + SPAN }
    );
}

#[test]
fn a_try_that_decides_nothing_waits_longer_each_time_up_to_five_minutes() {
    let waits: Vec<i64> = (0..9).map(delete_wait_ms).collect();
    assert_eq!(
        waits,
        [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000]
    );
    assert_eq!(delete_wait_ms(-1), 5_000);
    assert_eq!(delete_wait_ms(i64::MAX), 300_000);
}
