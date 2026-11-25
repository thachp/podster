#![allow(clippy::expect_used, clippy::panic)]
//! The Public Suffix List snapshot the API is built with (docs/m6-plan.md, step 8a, open question 1): its recorded
//! SHA-256 and licence header, its two sections, every rule readable, and what the whole list decides: plain, wildcard
//! and exception rules, international names in either form, and the private section's shared apexes. Its age isn't
//! checked here, so `cargo test` never starts failing by the calendar: `scripts/public-suffix-list check` does that,
//! weekly in CI and before each staging deploy (the architect, 2026-11-25).

use podster_core::hostnames::*;
use sha2::{Digest, Sha256};

const LIST: &str = include_str!("../../../third_party/public-suffix-list/public_suffix_list.dat");
const SNAPSHOT: &str = include_str!("../../../third_party/public-suffix-list/SNAPSHOT");
const CONTENT: &str = "podster.site";

fn recorded(key: &str) -> &'static str {
    SNAPSHOT
        .lines()
        .find_map(|line| line.strip_prefix(key)?.strip_prefix('='))
        .unwrap_or_else(|| panic!("SNAPSHOT records no {key}"))
}

fn rules() -> PublicSuffixRules {
    PublicSuffixRules::parse(&public_suffix_rules(LIST))
        .expect("every rule in the snapshot is readable")
}

fn map(name: &str) -> Result<String, HostnameRefusal> {
    mappable_by(name, CONTENT, Some(&rules()), false, 0)
}

#[test]
fn the_snapshot_is_the_one_recorded_unmodified_with_its_licence() {
    let sum: String = Sha256::digest(LIST.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    assert_eq!(
        sum,
        recorded("sha256"),
        "run scripts/public-suffix-list check"
    );
    assert_eq!(
        recorded("source"),
        "https://publicsuffix.org/list/public_suffix_list.dat"
    );
    let retrieved = recorded("retrieved");
    assert!(
        retrieved.len() == 10
            && retrieved
                .bytes()
                .enumerate()
                .all(|(i, b)| if i == 4 || i == 7 {
                    b == b'-'
                } else {
                    b.is_ascii_digit()
                }),
        "{retrieved}"
    );
    assert!(LIST.starts_with(
        "// This Source Code Form is subject to the terms of the Mozilla Public\n// License, v. 2.0."
    ));
}

#[test]
fn the_snapshot_has_its_icann_and_private_sections_once_each_in_order() {
    let at = |marker: &str| {
        let found: Vec<usize> = LIST
            .lines()
            .enumerate()
            .filter(|(_, l)| *l == marker)
            .map(|(i, _)| i)
            .collect();
        match found[..] {
            [line] => line,
            _ => panic!("{marker} appears {} times", found.len()),
        }
    };
    let lines = [
        at("// ===BEGIN ICANN DOMAINS==="),
        at("// ===END ICANN DOMAINS==="),
        at("// ===BEGIN PRIVATE DOMAINS==="),
        at("// ===END PRIVATE DOMAINS==="),
    ];
    assert!(lines.is_sorted_by(|a, b| a < b), "{lines:?}");
}

#[test]
fn every_rule_in_the_snapshot_is_readable_from_both_sections() {
    let written = public_suffix_rules(LIST);
    // About fourteen thousand today; far fewer means the file was cut short.
    assert!(written.len() > 10_000, "{}", written.len());
    // One unreadable rule fails the whole list closed, so parsing at all reads every rule.
    assert_eq!(rules().len(), written.len());
    assert!(written.contains(&"co.uk") && written.contains(&"github.io"));
    assert_eq!(map("example.com"), Ok("example.com".into()));
}

#[test]
fn plain_rules_refuse_the_suffix_and_allow_a_name_under_it() {
    for suffix in ["co.uk", "CO.UK.", "kawasaki.miyagi.jp"] {
        assert_eq!(map(suffix), Err(HostnameRefusal::PublicSuffix), "{suffix}");
    }
    for ok in [
        "example.co.uk",
        "app.example.co.uk",
        "town.kawasaki.miyagi.jp",
    ] {
        assert!(map(ok).is_ok(), "{ok}");
    }
    // A top-level label no rule covers can't be classified, and fails closed.
    assert_eq!(map("app.example.zz"), Err(HostnameRefusal::Unclassified));
}

#[test]
fn wildcard_and_exception_rules_hold_as_the_list_defines() {
    // `*.ck` with `!www.ck`.
    assert_eq!(map("anything.ck"), Err(HostnameRefusal::PublicSuffix));
    assert!(map("app.anything.ck").is_ok());
    assert_eq!(map("www.ck"), Ok("www.ck".into()));
    // `*.kawasaki.jp` with `!city.kawasaki.jp`.
    assert_eq!(map("kawasaki.jp"), Err(HostnameRefusal::PublicSuffix));
    assert_eq!(map("ward.kawasaki.jp"), Err(HostnameRefusal::PublicSuffix));
    assert!(map("shop.ward.kawasaki.jp").is_ok());
    assert_eq!(map("city.kawasaki.jp"), Ok("city.kawasaki.jp".into()));
    assert!(map("www.city.kawasaki.jp").is_ok());
}

#[test]
fn an_international_rule_holds_in_unicode_and_in_punycode() {
    // The list writes `公司.cn` in Unicode; a name arrives in either form and is compared in its ASCII form.
    for suffix in ["公司.cn", "xn--55qx5d.cn"] {
        assert_eq!(map(suffix), Err(HostnameRefusal::PublicSuffix), "{suffix}");
    }
    for name in ["例子.公司.cn", "xn--fsqu00a.xn--55qx5d.cn"] {
        assert_eq!(map(name), Ok("xn--fsqu00a.xn--55qx5d.cn".into()), "{name}");
    }
    // An international top-level domain, `中国`.
    assert_eq!(map("中国"), Err(HostnameRefusal::SingleLabel));
    assert_eq!(map("例子.中国"), Ok("xn--fsqu00a.xn--fiqs8s".into()));
}

#[test]
fn a_private_sections_shared_apex_is_refused_and_a_name_under_it_is_not() {
    // The whole list is read (the architect, 2026-11-25): a shared apex someone else runs can't be claimed, as
    // browsers treat it. A name under it can, by whoever publishes the challenge in its DNS.
    for apex in ["github.io", "blogspot.com", "GitHub.IO."] {
        assert_eq!(map(apex), Err(HostnameRefusal::PublicSuffix), "{apex}");
    }
    assert_eq!(map("me.github.io"), Ok("me.github.io".into()));
    assert!(map("app.me.github.io").is_ok());
}

#[test]
fn rules_read_once_decide_as_rules_read_on_each_call() {
    let written = public_suffix_rules(LIST);
    let parsed = rules();
    for name in [
        "github.io",
        "me.github.io",
        "co.uk",
        "app.example.zz",
        "anything.ck",
        "www.ck",
        "podster.site",
        "example.com",
    ] {
        assert_eq!(
            mappable_by(name, CONTENT, Some(&parsed), false, 0),
            mappable(name, CONTENT, &written, false, 0),
            "{name}"
        );
    }
    // Rules missing or unreadable fail closed either way.
    assert_eq!(PublicSuffixRules::parse(&[]), None);
    assert_eq!(PublicSuffixRules::parse(&["com", "a..b"]), None);
    assert_eq!(
        mappable_by("example.com", CONTENT, None, false, 0),
        Err(HostnameRefusal::Unclassified)
    );
}
