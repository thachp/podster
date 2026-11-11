//! A deployment's list of who may ask for a room's repository (M5, ADR 0009, which is proposed; added by the
//! architect on 2026-11-11 after the security review). The list is an input: nothing here reads a setting.

use podster_core::provisioning::{
    is_test_person, RepositoryRequesters, TEST_PEOPLE_ENTRY, TEST_PERSON_PREFIX,
};

const OWNER: &str = "per_owner1";
const TEST_PERSON: &str = "per_e2e_0123456789abcdef0123456789abcdef";
const STRANGER: &str = "per_Xy7stranger";

fn only(people: &[&str], test_people: bool) -> RepositoryRequesters {
    RepositoryRequesters::Only {
        people: people.iter().map(|p| p.to_string()).collect(),
        test_people,
    }
}

#[test]
fn an_absent_setting_is_everyone() {
    let unset = RepositoryRequesters::parse(None);
    assert_eq!(unset, RepositoryRequesters::Everyone);
    for person in [OWNER, TEST_PERSON, STRANGER, "per_e2e_", ""] {
        assert!(unset.allows(person), "{person}");
    }
}

#[test]
fn a_list_allows_exactly_the_people_it_names() {
    let list = RepositoryRequesters::parse(Some("per_owner1,per_second-one"));
    assert_eq!(list, only(&["per_owner1", "per_second-one"], false));
    assert!(list.allows(OWNER));
    assert!(list.allows("per_second-one"));
    // Not listed, and no test people without the entry for them.
    assert!(!list.allows(STRANGER));
    assert!(!list.allows(TEST_PERSON));
    // Exactly, never by a prefix, a suffix or another case.
    for near in [
        "per_owner",
        "per_owner11",
        "per_Owner1",
        "PER_OWNER1",
        " per_owner1",
        "owner1",
        "",
    ] {
        assert!(!list.allows(near), "{near:?}");
    }
}

#[test]
fn the_test_people_entry_allows_every_test_person_and_nobody_else() {
    assert_eq!(TEST_PEOPLE_ENTRY, "test-people");
    assert_eq!(TEST_PERSON_PREFIX, "per_e2e_");
    let list = RepositoryRequesters::parse(Some("per_owner1,test-people"));
    assert_eq!(list, only(&["per_owner1"], true));
    assert!(list.allows(TEST_PERSON));
    assert!(list.allows("per_e2e_x"));
    assert!(list.allows(OWNER));
    assert!(!list.allows(STRANGER));
    // The prefix alone, or something that only looks like it, is no test person.
    for not_one in [
        "per_e2e_",
        "per_e2e",
        "per_E2E_abc",
        "e2e_abc",
        "agt_e2e_abc",
        "xper_e2e_abc",
        "per_xe2e_abc",
        "",
    ] {
        assert!(!is_test_person(not_one), "{not_one:?}");
        assert!(!list.allows(not_one), "{not_one:?}");
    }
    // The entry alone, and in any place in the list.
    assert_eq!(
        RepositoryRequesters::parse(Some("test-people")),
        only(&[], true)
    );
    assert_eq!(
        RepositoryRequesters::parse(Some("test-people,per_owner1")),
        only(&["per_owner1"], true)
    );
    // A test person named by their own ID is allowed as anyone listed is, without the entry.
    let named = RepositoryRequesters::parse(Some(TEST_PERSON));
    assert!(named.allows(TEST_PERSON));
    assert!(!named.allows("per_e2e_another"));
}

#[test]
fn spaces_around_an_entry_are_ignored() {
    assert_eq!(
        RepositoryRequesters::parse(Some(" per_owner1 , test-people ")),
        only(&["per_owner1"], true)
    );
}

#[test]
fn an_empty_or_malformed_setting_is_nobody() {
    let nobody = RepositoryRequesters::nobody();
    assert_eq!(nobody, only(&[], false));
    let long = format!("per_{}", "a".repeat(125));
    let malformed = [
        // Empty, and blank.
        "",
        " ",
        ",",
        // An empty entry anywhere closes the whole list, the good entries with it.
        "per_owner1,",
        ",per_owner1",
        "per_owner1,,test-people",
        "per_owner1, ,test-people",
        // Not a person's ID.
        "owner1",
        "per_",
        "agt_owner1",
        "org_owner1",
        "per_owner1;per_two",
        "per_owner1 per_two",
        "per_owner 1",
        "per_owner1\n",
        "per_owner1\t",
        "per_ówner",
        "per_owner1*",
        "*",
        "all",
        "everyone",
        "true",
        // Not the entry for test people.
        "test_people",
        "Test-People",
        "test-people*",
        "per_e2e_*",
        // Too long to be an ID.
        long.as_str(),
        // One bad entry beside good ones.
        "per_owner1,test-people,nope",
    ];
    for value in malformed {
        let read = RepositoryRequesters::parse(Some(value));
        assert_eq!(read, nobody, "{value:?}");
        for person in [OWNER, TEST_PERSON, STRANGER, "", "per_", value] {
            assert!(!read.allows(person), "{value:?} {person:?}");
        }
    }
    // The longest ID that is one.
    let longest = format!("per_{}", "a".repeat(124));
    assert!(RepositoryRequesters::parse(Some(&longest)).allows(&longest));
}
