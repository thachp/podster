#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]
//! The preview form of a serve entry (M8 step 4; the preview plan's 3.1, ADR 0010's revision on previews, item 2):
//! `preview:<access epoch>:` and then exactly a production entry's form. The vectors are
//! `packages/contracts/serve-entry.fixture.json`'s, which the content Worker is tested against too (M8 step 8), so the
//! two readers can't drift apart. The fixture is read as `serve_entry_fixture.rs` reads it.

use podster_core::app_requests::HostKind;
use podster_core::preview::MAX_ACCESS_EPOCH;
use podster_core::serve_entry::{
    custom_entry_script_kind, default_entry_script, preview_custom_entry_script_kind,
    preview_custom_entry_value, preview_entry_script, preview_entry_value, PreviewEntry, CODE_MARK,
    PREVIEW_MARK,
};

/// The slot every fixture vector names.
const SLOT: &str = "pvw_0123456789abcdef0123456789abcdef";

const FIXTURE: &str = include_str!("../../../packages/contracts/serve-entry.fixture.json");

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
fn the_preview_mark_is_the_fixtures() {
    assert_eq!(scalar("preview_mark"), PREVIEW_MARK);
    assert_eq!(PREVIEW_MARK, "preview:");
    assert_eq!(scalar("preview_epoch_pattern"), "^(0|[1-9][0-9]{0,14})$");
    // The largest epoch the pattern takes is the core's largest access epoch.
    assert_eq!(MAX_ACCESS_EPOCH.to_string(), "9".repeat(15));
}

#[test]
fn every_valid_preview_entry_reads_back_and_is_written_exactly_so() {
    let valid = strings("valid_preview_entries");
    assert!(valid.len() >= 5);
    for value in valid {
        let Some(PreviewEntry {
            slot,
            epoch,
            kind,
            script,
        }) = preview_entry_script(value)
        else {
            panic!("{value:?} should be a preview entry");
        };
        assert_eq!(slot, SLOT);
        assert_eq!(
            preview_entry_value(slot, epoch, kind, script).as_deref(),
            Some(value)
        );
        let expected_kind = if value.contains(CODE_MARK) {
            HostKind::Code
        } else {
            HostKind::Static
        };
        assert_eq!(kind, expected_kind, "{value:?}");
    }
}

#[test]
fn every_invalid_preview_entry_is_refused() {
    let invalid = strings("invalid_preview_entries");
    assert!(invalid.len() >= 40);
    assert!(invalid.contains(&""));
    for value in invalid {
        assert_eq!(preview_entry_script(value), None, "{value:?}");
    }
}

#[test]
fn every_valid_preview_custom_entry_reads_back_for_its_own_host_alone() {
    let host = scalar("custom_entry_host");
    assert_eq!(host, "app.example.com");
    let valid = strings("valid_preview_custom_entries");
    assert!(valid.len() >= 3);
    for value in valid {
        let Some(PreviewEntry {
            slot,
            epoch,
            kind,
            script,
        }) = preview_custom_entry_script_kind(host, value)
        else {
            panic!("{value:?} should be {host}'s preview entry");
        };
        assert_eq!(
            preview_custom_entry_value(slot, epoch, kind, host, script).as_deref(),
            Some(value)
        );
        assert_eq!(
            preview_custom_entry_script_kind("www.example.com", value),
            None
        );
    }
    let invalid = strings("invalid_preview_custom_entries");
    assert!(invalid.len() >= 25);
    for value in invalid {
        assert_eq!(
            preview_custom_entry_script_kind(host, value),
            None,
            "{value:?}"
        );
    }
}

/// The two forms cross: a production reader never reads a preview entry, and a preview reader never reads a production
/// one, so neither namespace's script can be named through the other's host.
#[test]
fn production_and_preview_entries_never_read_as_each_other() {
    let host = scalar("custom_entry_host");
    for value in strings("valid_preview_entries")
        .into_iter()
        .chain(strings("valid_preview_custom_entries"))
    {
        assert_eq!(default_entry_script(value), None, "{value:?}");
        assert_eq!(custom_entry_script_kind(host, value), None, "{value:?}");
    }
    for value in strings("valid_script_names")
        .into_iter()
        .chain(strings("valid_code_entries"))
    {
        assert_eq!(preview_entry_script(value), None, "{value:?}");
    }
    for value in strings("valid_custom_entries")
        .into_iter()
        .chain(strings("valid_code_custom_entries"))
    {
        assert_eq!(
            preview_custom_entry_script_kind(host, value),
            None,
            "{value:?}"
        );
    }
}

#[test]
fn no_preview_entry_is_written_past_the_largest_epoch_or_for_a_name_podster_doesnt_make() {
    let script = "k3v9q2.rel_0123456789abcdef0123456789abcdef";
    let host = "app.example.com";
    assert!(preview_entry_value(SLOT, MAX_ACCESS_EPOCH, HostKind::Static, script).is_some());
    assert_eq!(
        preview_entry_value(SLOT, MAX_ACCESS_EPOCH + 1, HostKind::Static, script),
        None
    );
    assert_eq!(
        preview_entry_value(SLOT, u64::MAX, HostKind::Code, script),
        None
    );
    assert_eq!(
        preview_custom_entry_value(SLOT, MAX_ACCESS_EPOCH + 1, HostKind::Static, host, script),
        None
    );
    for bad in ["", "stopped", "_stop", "k3v9q2", "someone-elses-script"] {
        assert_eq!(
            preview_entry_value(SLOT, 0, HostKind::Static, bad),
            None,
            "{bad:?}"
        );
        assert_eq!(
            preview_custom_entry_value(SLOT, 0, HostKind::Static, host, bad),
            None,
            "{bad:?}"
        );
    }
    // A host Rust never writes for gets no preview entry either.
    for refused in strings("custom_entry_refused_hosts") {
        assert_eq!(
            preview_custom_entry_value(SLOT, 0, HostKind::Static, refused, script),
            None,
            "{refused:?}"
        );
    }
}

/// Every epoch, written and read back, is the same epoch, and every decimal the pattern refuses is refused.
#[test]
fn property_an_epoch_round_trips_and_only_the_patterns_decimals_read() {
    let script = "k3v9q2.rel_0123456789abcdef0123456789abcdef";
    let mut seed = 0x5eed_e90c_u64;
    let mut next = || {
        seed = seed
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        seed >> 11
    };
    for _ in 0..5_000 {
        let epoch = next() % (MAX_ACCESS_EPOCH + 1);
        for kind in [HostKind::Static, HostKind::Code] {
            let value = preview_entry_value(SLOT, epoch, kind, script).unwrap_or_default();
            assert_eq!(
                preview_entry_script(&value),
                Some(PreviewEntry {
                    slot: SLOT,
                    epoch,
                    kind,
                    script
                })
            );
            // A leading zero, a sign or a space before the epoch makes it no entry, and so does a lost slot.
            let prefix = format!("{PREVIEW_MARK}{SLOT}:");
            let rest = value.strip_prefix(&prefix).unwrap_or_default();
            for twisted in [
                format!("{prefix}0{rest}"),
                format!("{prefix}+{rest}"),
                format!("{prefix} {rest}"),
                format!("{PREVIEW_MARK}{rest}"),
            ] {
                assert_eq!(preview_entry_script(&twisted), None, "{twisted:?}");
            }
        }
    }
}

/// The entry names its slot, so a host a later slot holds never reads as the earlier slot's (M8 step 4's review).
#[test]
fn an_entry_names_exactly_its_own_slot() {
    let script = "k3v9q2.rel_0123456789abcdef0123456789abcdef";
    let other = "pvw_fedcba9876543210fedcba9876543210";
    let value = preview_entry_value(other, 3, HostKind::Static, script).unwrap();
    assert_eq!(preview_entry_script(&value).map(|e| e.slot), Some(other));
    for bad in [
        "",
        "pvs_fedcba9876543210fedcba9876543210",
        "pvw_FEDCBA9876543210fedcba9876543210",
        "pvw_1",
        "pvw_fedcba9876543210fedcba9876543210:",
    ] {
        assert_eq!(
            preview_entry_value(bad, 3, HostKind::Static, script),
            None,
            "{bad:?}"
        );
        assert_eq!(
            preview_custom_entry_value(bad, 3, HostKind::Static, "app.example.com", script),
            None,
            "{bad:?}"
        );
    }
}
