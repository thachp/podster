#![allow(clippy::expect_used, clippy::panic)]
//! The Public Suffix List snapshot the API is built with (docs/m6-plan.md, step 8a, open question 1): its recorded
//! SHA-256, its age, every ICANN rule readable, and what the real list's ICANN section decides: plain, wildcard and
//! exception rules, international names in either form, and the private section left out.

use podster_core::hostnames::*;
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};

const LIST: &str = include_str!("../../../third_party/public-suffix-list/public_suffix_list.dat");
const SNAPSHOT: &str = include_str!("../../../third_party/public-suffix-list/SNAPSHOT");
const CONTENT: &str = "podster.site";
/// The plan's rule: a CI check that fails once the snapshot is more than 90 days old.
const MAX_AGE_DAYS: i64 = 90;

fn recorded(key: &str) -> &'static str {
    SNAPSHOT
        .lines()
        .find_map(|line| line.strip_prefix(key)?.strip_prefix('='))
        .unwrap_or_else(|| panic!("SNAPSHOT records no {key}"))
}

/// Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant's `days_from_civil`).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn map(name: &str) -> Result<String, HostnameRefusal> {
    mappable(name, CONTENT, &icann_public_suffix_rules(LIST), false, 0)
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
    assert!(LIST.starts_with(
        "// This Source Code Form is subject to the terms of the Mozilla Public\n// License, v. 2.0."
    ));
}

#[test]
fn the_snapshot_is_at_most_ninety_days_old() {
    let retrieved = recorded("retrieved");
    let parts: Vec<i64> = retrieved
        .split('-')
        .map(|p| p.parse().expect("retrieved is YYYY-MM-DD"))
        .collect();
    let [y, m, d] = parts[..] else {
        panic!("retrieved is YYYY-MM-DD: {retrieved}")
    };
    let today = i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after 1970")
            .as_secs()
            / 86_400,
    )
    .expect("days fit");
    let age = today - days_from_civil(y, m, d);
    assert!(age >= 0, "retrieved {retrieved} is in the future");
    assert!(
        age <= MAX_AGE_DAYS,
        "the Public Suffix List snapshot is {age} days old, more than {MAX_AGE_DAYS}. Run: scripts/public-suffix-list refresh"
    );
}

#[test]
fn every_icann_rule_in_the_snapshot_is_readable() {
    let rules = icann_public_suffix_rules(LIST);
    // About seven thousand today; a much smaller number means the section was cut short.
    assert!(rules.len() > 5_000, "{}", rules.len());
    // `mappable` fails closed on a single unreadable rule, so one ordinary name passing reads every rule.
    assert_eq!(map("example.com"), Ok("example.com".into()));
    // Only the ICANN section: nothing from before it or after it.
    assert!(rules.contains(&"com") && rules.contains(&"co.uk"));
    assert!(!rules.contains(&"github.io") && !rules.contains(&"blogspot.com"));
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
fn the_private_section_is_left_out() {
    // Listed only in the private section, so under the ICANN rules alone each is an ordinary registrable name: a claim
    // on it still needs the challenge in its own DNS, which only its owner can publish.
    for name in ["github.io", "me.github.io", "blogspot.com"] {
        assert!(map(name).is_ok(), "{name}");
    }
    // Read with the whole list, `github.io` would be a public suffix: the ICANN reading is the narrower one.
    assert_eq!(
        mappable("github.io", CONTENT, &public_suffix_rules(LIST), false, 0),
        Err(HostnameRefusal::PublicSuffix)
    );
}

#[test]
fn a_list_without_one_whole_icann_section_gives_no_rules() {
    let ok = format!("// header\n{ICANN_BEGIN}\ncom\n// c\nco.uk extra\n{ICANN_END}\n// ===BEGIN PRIVATE DOMAINS===\ngithub.io\n");
    assert_eq!(icann_public_suffix_rules(&ok), ["com", "co.uk"]);
    assert_eq!(
        icann_public_suffix_rules(&format!("\u{FEFF}{ok}")),
        ["com", "co.uk"]
    );
    for bad in [
        String::new(),
        "com\nco.uk\n".to_string(),
        format!("{ICANN_BEGIN}\ncom\n"),
        format!("com\n{ICANN_END}\n"),
        format!("{ICANN_END}\ncom\n{ICANN_BEGIN}\n"),
        format!("{ICANN_BEGIN}\ncom\n{ICANN_BEGIN}\nnet\n{ICANN_END}\n"),
        format!("{ICANN_BEGIN}\ncom\n{ICANN_END}\nnet\n{ICANN_END}\n"),
    ] {
        let rules = icann_public_suffix_rules(&bad);
        assert!(rules.is_empty(), "{bad:?}");
        assert_eq!(
            mappable("example.com", CONTENT, &rules, false, 0),
            Err(HostnameRefusal::Unclassified)
        );
    }
}
