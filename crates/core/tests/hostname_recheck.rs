#![allow(clippy::indexing_slicing)]
//! M6 step 8d: the daily recheck of a committed claim's challenge (ADR 0010, custom domains, step 7). How a resolver's
//! answer is read into a match, a definite no or no answer, after spike D (2026-11-18), and when the recheck is due.

use podster_core::hostname_recheck::*;
use podster_core::hostnames::{
    challenge_value, recheck_claim, ClaimEnd, ProofHistory, RecheckDecision, RecheckOutcome,
    DEFINITE_NO_SPAN_MS, NO_PROOF_LIMIT_MS, RECHECK_INTERVAL_MS,
};

const HOUR: i64 = 60 * 60 * 1000;
const DAY: i64 = 24 * HOUR;
const NOW: i64 = 1_000 * DAY;
const ASKED: &str = "_podster-challenge.app.example.com";

fn value() -> String {
    challenge_value([0xab; 32])
}

/// Cloudflare's form of a TXT record's `data`, as spike D saw it: the text in quotes.
fn quoted(text: &str) -> String {
    format!("\"{text}\"")
}

fn txt<'a>(name: &'a str, data: &'a str) -> DohRecord<'a> {
    DohRecord {
        name,
        kind: TXT,
        data,
    }
}

fn cname<'a>(name: &'a str, data: &'a str) -> DohRecord<'a> {
    DohRecord {
        name,
        kind: CNAME,
        data,
    }
}

fn read(status: i64, records: &[DohRecord]) -> RecheckOutcome {
    read_challenge(
        ASKED,
        &DohAnswer {
            status,
            truncated: false,
            records,
        },
        &value(),
    )
}

#[test]
fn the_requests_own_value_in_cloudflares_quoted_form_is_a_match() {
    let data = quoted(&value());
    assert_eq!(read(NOERROR, &[txt(ASKED, &data)]), RecheckOutcome::Match);
    // Beside other values, split into strings, in Google's bare form, and with a trailing dot or upper case on the owner.
    let split = format!("\"{}\" \"{}\"", &value()[..32], &value()[32..]);
    let other = quoted("v=spf1 -all");
    assert_eq!(
        read(NOERROR, &[txt(ASKED, &other), txt(ASKED, &split)]),
        RecheckOutcome::Match
    );
    let bare = value();
    let dotted = format!("{ASKED}.");
    assert_eq!(read(NOERROR, &[txt(&dotted, &bare)]), RecheckOutcome::Match);
    let upper = ASKED.to_ascii_uppercase();
    assert_eq!(read(NOERROR, &[txt(&upper, &data)]), RecheckOutcome::Match);
    // AD isn't read at all: an unsigned zone answers as a signed one does (spike D: none of Podster's own is signed).
}

#[test]
fn nxdomain_and_noerror_with_no_txt_are_definite_noes() {
    assert_eq!(read(NXDOMAIN, &[]), RecheckOutcome::DefiniteNo);
    // A wildcard of another type over the challenge's name answers NOERROR with nothing (spike D, `opster.dev`).
    assert_eq!(read(NOERROR, &[]), RecheckOutcome::DefiniteNo);
    // Readable values, none of them this request's: the value isn't there.
    let other = quoted(&challenge_value([0xac; 32]));
    assert_eq!(
        read(NOERROR, &[txt(ASKED, &other)]),
        RecheckOutcome::DefiniteNo
    );
    // The value in another case is another value.
    let upper = quoted(&value().to_ascii_uppercase());
    assert_eq!(
        read(NOERROR, &[txt(ASKED, &upper)]),
        RecheckOutcome::DefiniteNo
    );
    // A chain that ends at a name with no TXT, or at no name at all.
    assert_eq!(
        read(NOERROR, &[cname(ASKED, "elsewhere.example.net.")]),
        RecheckOutcome::DefiniteNo
    );
    assert_eq!(
        read(NXDOMAIN, &[cname(ASKED, "gone.example.net.")]),
        RecheckOutcome::DefiniteNo
    );
}

#[test]
fn every_other_response_code_or_a_truncated_answer_is_no_answer() {
    let data = quoted(&value());
    // SERVFAIL (a DNSSEC failure among them), FORMERR, REFUSED and anything else, even with the value in it.
    for status in [1, 2, 4, 5, 9, -1, 65_535] {
        assert_eq!(read(status, &[]), RecheckOutcome::ResolverError, "{status}");
        assert_eq!(
            read(status, &[txt(ASKED, &data)]),
            RecheckOutcome::ResolverError,
            "{status}"
        );
    }
    for status in [NOERROR, NXDOMAIN] {
        let truncated = DohAnswer {
            status,
            truncated: true,
            records: &[],
        };
        assert_eq!(
            read_challenge(ASKED, &truncated, &value()),
            RecheckOutcome::ResolverError
        );
    }
    // NXDOMAIN that still carries a TXT isn't a whole answer.
    assert_eq!(
        read(NXDOMAIN, &[txt(ASKED, &data)]),
        RecheckOutcome::ResolverError
    );
}

#[test]
fn a_txt_counts_only_when_its_owner_is_the_challenge_name_or_the_end_of_its_cname_chain() {
    let data = quoted(&value());
    // Through a CNAME, as `www.github.com` came back owned by `github.com` (spike D).
    let chained = [
        cname(ASKED, "challenge.example.net."),
        txt("challenge.example.net", &data),
    ];
    assert_eq!(read(NOERROR, &chained), RecheckOutcome::Match);
    let two = [
        cname(ASKED, "a.example.net."),
        cname("a.example.net", "b.example.org."),
        txt("b.example.org.", &data),
    ];
    assert_eq!(read(NOERROR, &two), RecheckOutcome::Match);
    // Another name's TXT, which the chain doesn't reach: it proves nothing, and an answer holding it isn't read.
    let stray = [txt("app.example.com", &data)];
    assert_eq!(read(NOERROR, &stray), RecheckOutcome::ResolverError);
    let beside = [cname(ASKED, "a.example.net."), txt("b.example.net", &data)];
    assert_eq!(read(NOERROR, &beside), RecheckOutcome::ResolverError);
    // A name with a CNAME holds nothing else, so a TXT on a link of the chain before its end is no answer.
    let mid = [cname(ASKED, "a.example.net."), txt(ASKED, &data)];
    assert_eq!(read(NOERROR, &mid), RecheckOutcome::ResolverError);
    // A CNAME that doesn't hang off the chain.
    let loose = [cname("x.example.net", "y.example.net.")];
    assert_eq!(read(NOERROR, &loose), RecheckOutcome::ResolverError);
}

#[test]
fn a_chain_that_loops_forks_or_runs_too_long_is_no_answer() {
    let back = format!("{ASKED}.");
    let looped = [
        cname(ASKED, "a.example.net."),
        cname("a.example.net", &back),
    ];
    assert_eq!(read(NOERROR, &looped), RecheckOutcome::ResolverError);
    let forked = [
        cname(ASKED, "a.example.net."),
        cname(ASKED, "b.example.net."),
    ];
    assert_eq!(read(NOERROR, &forked), RecheckOutcome::ResolverError);
    let names: Vec<String> = (0..=MAX_CNAME_CHAIN)
        .map(|n| format!("n{n}.example.net"))
        .collect();
    let mut long = vec![cname(ASKED, &names[0])];
    for pair in names.windows(2) {
        long.push(cname(&pair[0], &pair[1]));
    }
    assert_eq!(long.len(), MAX_CNAME_CHAIN + 1);
    assert_eq!(read(NOERROR, &long), RecheckOutcome::ResolverError);
    // At the bound exactly, it is read.
    let at_bound = &long[..MAX_CNAME_CHAIN];
    assert_eq!(read(NOERROR, at_bound), RecheckOutcome::DefiniteNo);
}

#[test]
fn an_unreadable_record_or_name_is_no_answer_for_a_no_but_never_hides_a_match() {
    let data = quoted(&value());
    // Google's bare form of text with spaces can't be told from several strings: not read (spike D).
    let ambiguous = "v=DMARC1; p=reject;";
    assert_eq!(
        read(NOERROR, &[txt(ASKED, ambiguous)]),
        RecheckOutcome::ResolverError
    );
    // Cloudflare's form exactly, as spike D recorded it, reads; one malformed is no answer.
    assert_eq!(
        read(NOERROR, &[txt(ASKED, "\"v=DMARC1; p=reject;\"")]),
        RecheckOutcome::DefiniteNo
    );
    for broken in [
        "\"abc",
        "\"ab\"x\"cd\"",
        "\"ab\" ",
        " \"ab\"",
        "\"a\\256\"",
        "",
    ] {
        assert_eq!(
            read(NOERROR, &[txt(ASKED, broken)]),
            RecheckOutcome::ResolverError,
            "{broken:?}"
        );
        // Beside the request's own value it still matches: the value is there.
        assert_eq!(
            read(NOERROR, &[txt(ASKED, broken), txt(ASKED, &data)]),
            RecheckOutcome::Match,
            "{broken:?}"
        );
    }
    // Owner names Podster can't read as a name.
    for owner in [
        "",
        ".",
        "a..b",
        "a b.example.com",
        "a\\032b.example.com",
        "é.example.com",
    ] {
        assert_eq!(
            read(NOERROR, &[txt(owner, &data)]),
            RecheckOutcome::ResolverError,
            "{owner:?}"
        );
    }
    // Any record type but TXT and CNAME (a DNAME, an RRSIG, an A) is something this reading doesn't explain.
    for kind in [1, 39, 46] {
        let other = DohRecord {
            name: ASKED,
            kind,
            data: "x",
        };
        assert_eq!(
            read(NOERROR, &[other]),
            RecheckOutcome::ResolverError,
            "{kind}"
        );
    }
}

#[test]
fn a_name_reads_as_dns_writes_it() {
    assert_eq!(
        dns_name("_Podster-Challenge.App.Example.com.").as_deref(),
        Some("_podster-challenge.app.example.com")
    );
    assert_eq!(dns_name("github.com").as_deref(), Some("github.com"));
    for bad in [
        "",
        ".",
        "..",
        "a..b",
        "a.b..",
        "-",
        "a b",
        "a\\.b",
        &"a".repeat(64),
        &format!("{}.com", "a.".repeat(130)),
    ] {
        assert_eq!(dns_name(bad), None, "{bad:?}");
    }
}

#[test]
fn the_recheck_is_due_a_day_after_the_last_look_and_never_later_than_seven_days_after_the_last_proof(
) {
    assert_eq!(next_recheck_at(NOW, None), NOW + RECHECK_INTERVAL_MS);
    assert_eq!(next_recheck_at(NOW, Some(NOW + 3 * DAY)), NOW + 4 * DAY);
    // Six and a half days after the last proof, the next look is at the seventh day, not a day later.
    assert_eq!(
        next_recheck_at(NOW, Some(NOW + 6 * DAY + 12 * HOUR)),
        NOW + NO_PROOF_LIMIT_MS
    );
    // A look before the last proof (a clock that ran backwards) never makes one due before a day after the proof.
    assert_eq!(
        next_recheck_at(NOW, Some(NOW - DAY)),
        NOW + RECHECK_INTERVAL_MS
    );
}

#[test]
fn a_look_is_made_only_with_the_gate_on_claims_open_and_a_resolver() {
    assert_eq!(no_look(true, true), None);
    assert_eq!(no_look(false, true), Some("hostname_claims_incomplete"));
    assert_eq!(no_look(true, false), Some("hostname_resolver_missing"));
    assert_eq!(no_look(false, false), Some("hostname_claims_incomplete"));
}

#[test]
fn daily_looks_end_a_removed_challenge_on_the_second_day_and_a_silent_name_on_the_seventh() {
    // Each day's look as the room records it, a day apart from the last proof.
    let run = |outcomes: &[RecheckOutcome]| {
        let mut history = ProofHistory {
            last_success_at: NOW,
            definite_no_since: None,
        };
        let mut last = None;
        for outcome in outcomes {
            let at = next_recheck_at(history.last_success_at, last);
            match recheck_claim(history, *outcome, at) {
                RecheckDecision::Keep(kept) => {
                    history = kept;
                    last = Some(at);
                }
                RecheckDecision::End(end) => return Some((end, at)),
            }
        }
        None
    };
    use RecheckOutcome::{DefiniteNo as No, Match as Yes, ResolverError as Silent};
    assert_eq!(
        run(&[No, No]),
        Some((ClaimEnd::ChallengeRemoved, NOW + DAY + DEFINITE_NO_SPAN_MS))
    );
    // No answer between two noes neither counts nor resets: the second no, two days after the first, ends it.
    assert_eq!(
        run(&[No, Silent, No]),
        Some((ClaimEnd::ChallengeRemoved, NOW + 3 * DAY))
    );
    // A match between resets.
    assert_eq!(run(&[No, Yes, No]), None);
    assert_eq!(
        run(&[Silent; 7]),
        Some((ClaimEnd::ProofLapsed, NOW + NO_PROOF_LIMIT_MS))
    );
    assert_eq!(run(&[Silent, Silent, Silent, Silent, Silent, Silent]), None);
}
