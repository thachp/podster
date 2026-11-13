//! The script names the private API writes as serve entries and the content Worker reads (M6 step 4, ADR 0010) are
//! judged by one rule, `podster_core::release::script_owner`. The content Worker is TypeScript and has its own copy
//! of that rule. This reads the vectors both are tested against, so the two can't drift apart.
use podster_core::release::{script_owner, ScriptOwner};

const FIXTURE: &str = include_str!("../../../packages/contracts/serve-entry.fixture.json");

/// The strings of one array in the fixture. The fixture promises no string holds a quote or a backslash, so a string
/// is whatever sits between two quotes. An array that isn't there reads as empty, which each test below refuses.
fn strings(name: &str) -> Vec<&'static str> {
    let Some(start) = FIXTURE.find(&format!("\"{name}\": [")) else {
        return Vec::new();
    };
    let rest = FIXTURE.get(start..).unwrap_or_default();
    let (Some(open), Some(close)) = (rest.find('['), rest.find(']')) else {
        return Vec::new();
    };
    rest.get(open + 1..close)
        .unwrap_or_default()
        .split('"')
        .skip(1)
        .step_by(2)
        .collect()
}

#[test]
fn the_fixture_holds_no_quote_or_backslash_inside_a_string() {
    assert!(!FIXTURE.contains('\\'));
}

#[test]
fn every_valid_name_is_one_podster_made() {
    let names = strings("valid_script_names");
    assert!(names.len() >= 4);
    for name in names {
        assert!(
            matches!(script_owner(name), ScriptOwner::Podster { .. }),
            "{name:?} should be a script's name"
        );
    }
}

#[test]
fn every_invalid_name_is_foreign() {
    let names = strings("invalid_script_names");
    assert!(names.len() >= 20);
    assert!(names.contains(&""));
    for name in names {
        assert_eq!(
            script_owner(name),
            ScriptOwner::Foreign,
            "{name:?} should not be a script's name"
        );
    }
}
