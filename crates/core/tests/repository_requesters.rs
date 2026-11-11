//! A deployment's list of who may ask for a room's repository (M5, ADR 0009, which is proposed; added by the
//! architect on 2026-11-11 after the security review). The list is an input: nothing here reads a setting.

use podster_core::provisioning::{
    is_test_person, Configured, RepositoryRequesters, OPERATORS_ENTRY, TEST_PEOPLE_ENTRY, TEST_PERSON_PREFIX,
};

const OWNER: &str = "per_owner1";
const TEST_PERSON: &str = "per_e2e_0123456789abcdef0123456789abcdef";
const STRANGER: &str = "per_Xy7stranger";

/// The people this deployment's configuration names as operators, in most tests here. Without the `operators` entry
/// they count for nothing.
const OPS: [&str; 2] = ["per_operator_one", "per_operator_two"];

fn only(people: &[&str], test_people: bool) -> RepositoryRequesters {
    RepositoryRequesters::Only {
        people: people.iter().map(|p| p.to_string()).collect(),
        test_people,
        operators: false,
    }
}

/// A list with the `operators` entry.
fn with_operators(people: &[&str], test_people: bool) -> RepositoryRequesters {
    RepositoryRequesters::Only {
        people: people.iter().map(|p| p.to_string()).collect(),
        test_people,
        operators: true,
    }
}

#[test]
fn an_absent_setting_is_everyone() {
    let unset = RepositoryRequesters::parse(None);
    assert_eq!(unset, RepositoryRequesters::Everyone);
    for person in [OWNER, TEST_PERSON, STRANGER, "per_e2e_", ""] {
        assert!(unset.allows(person, &OPS), "{person}");
    }
}

#[test]
fn a_list_allows_exactly_the_people_it_names() {
    let list = RepositoryRequesters::parse(Some("per_owner1,per_second-one"));
    assert_eq!(list, only(&["per_owner1", "per_second-one"], false));
    assert!(list.allows(OWNER, &OPS));
    assert!(list.allows("per_second-one", &OPS));
    // Not listed, and no test people without the entry for them.
    assert!(!list.allows(STRANGER, &OPS));
    assert!(!list.allows(TEST_PERSON, &OPS));
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
        assert!(!list.allows(near, &OPS), "{near:?}");
    }
}

#[test]
fn the_test_people_entry_allows_every_test_person_and_nobody_else() {
    assert_eq!(TEST_PEOPLE_ENTRY, "test-people");
    assert_eq!(TEST_PERSON_PREFIX, "per_e2e_");
    let list = RepositoryRequesters::parse(Some("per_owner1,test-people"));
    assert_eq!(list, only(&["per_owner1"], true));
    assert!(list.allows(TEST_PERSON, &OPS));
    assert!(list.allows("per_e2e_x", &OPS));
    assert!(list.allows(OWNER, &OPS));
    assert!(!list.allows(STRANGER, &OPS));
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
        assert!(!list.allows(not_one, &OPS), "{not_one:?}");
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
    assert!(named.allows(TEST_PERSON, &OPS));
    assert!(!named.allows("per_e2e_another", &OPS));
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
            assert!(!read.allows(person, &OPS), "{value:?} {person:?}");
        }
    }
    // The longest ID that is one.
    let longest = format!("per_{}", "a".repeat(124));
    assert!(RepositoryRequesters::parse(Some(&longest)).allows(&longest, &OPS));
}

#[test]
fn the_operators_entry_allows_the_deployments_operators_and_only_with_the_entry() {
    assert_eq!(OPERATORS_ENTRY, "operators");
    let list = RepositoryRequesters::parse(Some("operators,test-people"));
    assert_eq!(list, with_operators(&[], true));
    // Each operator the deployment names, a test person, and nobody else.
    for operator in OPS {
        assert!(list.allows(operator, &OPS), "{operator}");
    }
    assert!(list.allows(TEST_PERSON, &OPS));
    assert!(!list.allows(STRANGER, &OPS));
    assert!(!list.allows(OWNER, &OPS));
    // Exactly, as for a listed ID.
    for near in [
        "per_operator",
        "per_operator_one1",
        "PER_OPERATOR_ONE",
        " per_operator_one",
        "operators",
        "",
    ] {
        assert!(!list.allows(near, &OPS), "{near:?}");
    }
    // The deployment names no operator, or its list is empty: the entry admits nobody, and the rest of the list stands.
    for none in [&[][..], &[""][..]] {
        for operator in OPS {
            assert!(!list.allows(operator, none), "{operator}");
        }
        assert!(!list.allows("", none));
        assert!(list.allows(TEST_PERSON, none));
    }
    // Without the entry, being an operator counts for nothing: it's never implied.
    for value in ["test-people", "per_owner1", "per_owner1,test-people"] {
        let without = RepositoryRequesters::parse(Some(value));
        for operator in OPS {
            assert!(!without.allows(operator, &OPS), "{value} {operator}");
        }
    }
    // The entry alone, in any place, beside IDs, and with spaces around it.
    assert_eq!(
        RepositoryRequesters::parse(Some("operators")),
        with_operators(&[], false)
    );
    assert_eq!(
        RepositoryRequesters::parse(Some("per_owner1, operators ,test-people")),
        with_operators(&["per_owner1"], true)
    );
    // An operator named by ID is allowed as anyone listed is, whatever the deployment's operators are.
    assert!(RepositoryRequesters::parse(Some("per_operator_one")).allows("per_operator_one", &[]));
    // Unset is still everyone, operator or not, whatever the deployment's operators are.
    assert!(RepositoryRequesters::parse(None).allows(STRANGER, &[]));
    // A word that only looks like the entry closes the whole list.
    for value in [
        "Operators",
        "operator",
        "operators*",
        "ops",
        "operators,admins",
        "OPERATORS",
        "per_owner1,operator",
    ] {
        let read = RepositoryRequesters::parse(Some(value));
        assert_eq!(read, RepositoryRequesters::nobody(), "{value:?}");
        for person in [OWNER, "per_operator_one", TEST_PERSON] {
            assert!(!read.allows(person, &OPS), "{value:?} {person}");
        }
    }
}

#[test]
fn only_a_setting_that_is_absent_is_everyone_and_one_that_cant_be_read_as_text_is_nobody() {
    assert_eq!(
        RepositoryRequesters::read(Configured::Absent),
        RepositoryRequesters::Everyone
    );
    // Bound, and not a string: a list, a number, an object, a binding of another kind, a failed read.
    let unreadable = RepositoryRequesters::read(Configured::Unreadable);
    assert_eq!(unreadable, RepositoryRequesters::nobody());
    for person in [OWNER, TEST_PERSON, STRANGER, "per_operator_one", ""] {
        assert!(!unreadable.allows(person, &OPS), "{person:?}");
    }
    // A string is read as the list it is, the empty one included.
    for value in ["", "per_owner1", "operators,test-people", "nope", "[\"operators\",\"test-people\"]", "7"] {
        assert_eq!(
            RepositoryRequesters::read(Configured::Text(value)),
            RepositoryRequesters::parse(Some(value)),
            "{value:?}"
        );
    }
    // What a list or a number would read as if something had turned it into text first: still nobody.
    for value in ["[\"operators\",\"test-people\"]", "operators,test-people]", "7", "[object Object]", "true", "null", "undefined"] {
        assert_eq!(
            RepositoryRequesters::read(Configured::Text(value)),
            RepositoryRequesters::nobody(),
            "{value:?}"
        );
    }
}
