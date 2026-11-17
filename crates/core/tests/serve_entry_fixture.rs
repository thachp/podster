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

/// A scalar string of the fixture, by the same reading as [`strings`].
fn scalar(name: &str) -> &'static str {
    let Some(start) = FIXTURE.find(&format!("\"{name}\": \"")) else {
        return "";
    };
    FIXTURE
        .get(start + name.len() + 5..)
        .and_then(|rest| rest.split('"').next())
        .unwrap_or_default()
}

#[test]
fn a_custom_hosts_entry_is_read_only_in_the_fixtures_form_and_for_its_own_host() {
    use podster_core::hostnames::{
        custom_entry_script, custom_entry_value, CUSTOM_ENTRY_SEPARATOR,
    };
    let host = scalar("custom_entry_host");
    assert_eq!(host, "app.example.com");
    assert_eq!(
        scalar("custom_entry_separator"),
        CUSTOM_ENTRY_SEPARATOR.to_string()
    );
    let valid = strings("valid_custom_entries");
    assert!(valid.len() >= 2);
    for value in valid {
        let script = custom_entry_script(host, value);
        assert!(script.is_some(), "{value:?} should be {host}'s entry");
        // What Rust writes for that script is exactly that value.
        assert_eq!(
            custom_entry_value(host, script.unwrap_or_default()).as_deref(),
            Some(value)
        );
    }
    let invalid = strings("invalid_custom_entries");
    assert!(invalid.len() >= 15);
    for value in invalid {
        assert_eq!(
            custom_entry_script(host, value),
            None,
            "{value:?} should not be {host}'s entry"
        );
    }
}

#[test]
fn no_custom_entry_is_written_or_read_for_a_host_rust_never_writes() {
    use podster_core::hostnames::{
        custom_entry_script, custom_entry_value, CUSTOM_ENTRY_SEPARATOR,
    };
    let script = strings("valid_script_names")
        .get(1)
        .copied()
        .unwrap_or_default();
    let refused = strings("custom_entry_refused_hosts");
    assert!(refused.len() >= 10);
    for host in refused {
        let value = format!("{script}{CUSTOM_ENTRY_SEPARATOR}{host}");
        assert_eq!(custom_entry_value(host, script), None, "{host:?}");
        assert_eq!(custom_entry_script(host, &value), None, "{host:?}");
    }
    // A public suffix alone is a formed host: the entry's form doesn't judge it, the claim does.
    let formed = strings("custom_entry_formed_hosts");
    assert!(formed.contains(&"co.uk"));
    for host in formed {
        let value = format!("{script}{CUSTOM_ENTRY_SEPARATOR}{host}");
        assert_eq!(
            custom_entry_value(host, script).as_deref(),
            Some(value.as_str())
        );
        assert_eq!(custom_entry_script(host, &value), Some(script));
    }
}

/// The mark is the fixture's, and no static entry of either form can begin with it.
#[test]
fn the_code_mark_is_the_fixtures_and_no_static_entry_can_begin_with_it() {
    use podster_core::serve_entry::CODE_MARK;
    assert_eq!(scalar("code_mark"), CODE_MARK);
    // It ends in a character no script's name and no written host holds.
    assert!(CODE_MARK.ends_with(':'));
    for name in strings("valid_script_names") {
        assert!(!name.contains(':'), "{name:?}");
    }
    for value in strings("valid_custom_entries") {
        assert!(!value.contains(':'), "{value:?}");
    }
}

#[test]
fn a_default_hosts_entry_reads_its_kind_by_the_mark_and_every_earlier_vector_reads_as_before() {
    use podster_core::app_requests::HostKind;
    use podster_core::serve_entry::{default_entry_script, default_entry_value, CODE_MARK};
    // Every static name is read as before: static, the same script, and written back unmarked.
    let valid = strings("valid_script_names");
    assert!(valid.len() >= 4);
    for name in valid {
        assert_eq!(
            default_entry_script(name),
            Some((HostKind::Static, name)),
            "{name:?}"
        );
        assert_eq!(
            default_entry_value(HostKind::Static, name).as_deref(),
            Some(name)
        );
        assert_eq!(
            default_entry_value(HostKind::Code, name),
            Some(format!("{CODE_MARK}{name}"))
        );
    }
    for name in strings("invalid_script_names") {
        assert_eq!(default_entry_script(name), None, "{name:?}");
        // A mark never makes a name that isn't a script's into one.
        let marked = format!("{CODE_MARK}{name}");
        assert_eq!(default_entry_script(&marked), None, "{marked:?}");
        assert_eq!(default_entry_value(HostKind::Static, name), None);
        assert_eq!(default_entry_value(HostKind::Code, name), None);
    }
    let code = strings("valid_code_entries");
    assert!(code.len() >= 4);
    for value in code {
        let read = default_entry_script(value);
        assert_eq!(
            read.map(|(kind, _)| kind),
            Some(HostKind::Code),
            "{value:?}"
        );
        let script = read.map(|(_, script)| script).unwrap_or_default();
        assert_eq!(Some(script), value.strip_prefix(CODE_MARK));
        assert_eq!(
            default_entry_value(HostKind::Code, script).as_deref(),
            Some(value)
        );
    }
    let unmarked = strings("static_entries_not_marked");
    assert!(unmarked.len() >= 2);
    for value in unmarked {
        assert_eq!(
            default_entry_script(value),
            Some((HostKind::Static, value)),
            "{value:?}"
        );
    }
    let invalid = strings("invalid_code_entries");
    assert!(invalid.len() >= 20);
    assert!(invalid.contains(&"code:"));
    for value in invalid {
        assert_eq!(default_entry_script(value), None, "{value:?}");
    }
}

#[test]
fn a_custom_hosts_entry_reads_its_kind_by_the_mark_and_every_earlier_vector_reads_as_before() {
    use podster_core::app_requests::HostKind;
    use podster_core::serve_entry::{custom_entry_script_kind, custom_entry_value_kind, CODE_MARK};
    let host = scalar("custom_entry_host");
    let valid = strings("valid_custom_entries");
    assert!(valid.len() >= 2);
    for value in valid {
        let read = custom_entry_script_kind(host, value);
        assert_eq!(
            read.map(|(kind, _)| kind),
            Some(HostKind::Static),
            "{value:?}"
        );
        let script = read.map(|(_, script)| script).unwrap_or_default();
        assert_eq!(
            custom_entry_value_kind(HostKind::Static, host, script).as_deref(),
            Some(value)
        );
        assert_eq!(
            custom_entry_value_kind(HostKind::Code, host, script),
            Some(format!("{CODE_MARK}{value}"))
        );
    }
    for value in strings("invalid_custom_entries") {
        assert_eq!(custom_entry_script_kind(host, value), None, "{value:?}");
        let marked = format!("{CODE_MARK}{value}");
        assert_eq!(custom_entry_script_kind(host, &marked), None, "{marked:?}");
    }
    let code = strings("valid_code_custom_entries");
    assert!(code.len() >= 2);
    for value in code {
        let read = custom_entry_script_kind(host, value);
        assert_eq!(
            read.map(|(kind, _)| kind),
            Some(HostKind::Code),
            "{value:?}"
        );
        let script = read.map(|(_, script)| script).unwrap_or_default();
        assert_eq!(
            custom_entry_value_kind(HostKind::Code, host, script).as_deref(),
            Some(value)
        );
    }
    let invalid = strings("invalid_code_custom_entries");
    assert!(invalid.len() >= 20);
    for value in invalid {
        assert_eq!(custom_entry_script_kind(host, value), None, "{value:?}");
    }
    // Each form is refused where the other is read: a default host's entry with code is no custom host's entry.
    for value in strings("valid_code_entries") {
        assert_eq!(custom_entry_script_kind(host, value), None, "{value:?}");
    }
    // And no entry is written for a host Rust never writes, marked or not.
    let script = strings("valid_script_names")
        .get(1)
        .copied()
        .unwrap_or_default();
    for refused in strings("custom_entry_refused_hosts") {
        assert_eq!(
            custom_entry_value_kind(HostKind::Code, refused, script),
            None
        );
    }
}

#[test]
fn a_kind_is_named_static_or_code_and_nothing_else() {
    use podster_core::app_requests::HostKind;
    use podster_core::serve_entry::{kind_name, kind_named};
    for kind in [HostKind::Static, HostKind::Code] {
        assert_eq!(kind_named(kind_name(kind)), Some(kind));
    }
    assert_eq!(kind_name(HostKind::Static), "static");
    assert_eq!(kind_name(HostKind::Code), "code");
    for other in ["", "Code", "STATIC", "code:", " code", "static ", "default"] {
        assert_eq!(kind_named(other), None, "{other:?}");
    }
}

#[test]
fn a_scripts_recorded_kind_is_static_only_when_recorded_static_or_never_recorded() {
    use podster_core::app_requests::HostKind;
    use podster_core::serve_entry::recorded_kind;
    assert_eq!(recorded_kind(None), HostKind::Static);
    assert_eq!(recorded_kind(Some("static")), HostKind::Static);
    assert_eq!(recorded_kind(Some("code")), HostKind::Code);
    // A record of any other kind is read as code, the stricter side, never as static files.
    for other in ["", "Static", "STATIC", "static ", "none", "code:"] {
        assert_eq!(recorded_kind(Some(other)), HostKind::Code, "{other:?}");
    }
}

#[test]
fn an_entry_read_back_matches_only_the_same_script_of_the_same_kind() {
    use podster_core::app_requests::HostKind;
    use podster_core::serve_entry::entry_is;
    let script = "k3v9q2.rel_0123456789abcdef0123456789abcdef";
    let other = "k3v9q2.rel_fedcba9876543210fedcba9876543210";
    for kind in [HostKind::Static, HostKind::Code] {
        assert!(entry_is(Some((kind, script)), Some((kind, script))));
        assert!(!entry_is(Some((kind, script)), Some((kind, other))));
        assert!(!entry_is(Some((kind, script)), None));
        assert!(!entry_is(None, Some((kind, script))));
    }
    // A kind that differs is as wrong as a script that differs, both ways.
    assert!(!entry_is(
        Some((HostKind::Code, script)),
        Some((HostKind::Static, script))
    ));
    assert!(!entry_is(
        Some((HostKind::Static, script)),
        Some((HostKind::Code, script))
    ));
    assert!(!entry_is(None, None));
}
