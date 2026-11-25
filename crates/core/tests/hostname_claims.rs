//! M6 step 8, the first PR: the room's challenge and the hostname's claim (ADR 0010, custom domains). The proof's TXT
//! text, when the room looks again, a request a room withdraws before it ever committed a claim, what a room's removal
//! does to each state, and what the room records from the claim object's answer.

use podster_core::hostname_requests::{
    after_ask, setup_status, unmap, AskOutcome, HostnameRequestState, HostnameSetup, Unmap,
};
use podster_core::hostnames::*;

const MINUTE: i64 = 60 * 1000;
const HOUR: i64 = 60 * MINUTE;
const NOW: i64 = 1_000 * 24 * HOUR;

const EMPTY: HostnameRecord = HostnameRecord {
    claim: None,
    ending: false,
    suspended: false,
    last_freed_at: None,
    last_suspended_at: None,
    last_lifted_at: None,
    generation: 0,
};

fn ask<'a>(room: &'a str, request: &'a str, generation: u64) -> ClaimAsk<'a> {
    ClaimAsk {
        room,
        request,
        requested_at: NOW,
        proof_matched: true,
        generation,
    }
}

#[test]
fn a_txt_records_text_is_its_strings_joined_with_their_quotes_and_escapes_undone() {
    assert_eq!(txt_rdata_text("\"abc\"").as_deref(), Some("abc"));
    // A long value comes as several strings, which are one value.
    assert_eq!(txt_rdata_text("\"ab\" \"cd\"").as_deref(), Some("abcd"));
    assert_eq!(txt_rdata_text("\"a\\\"b\"").as_deref(), Some("a\"b"));
    assert_eq!(txt_rdata_text("\"a\\\\b\"").as_deref(), Some("a\\b"));
    assert_eq!(txt_rdata_text("\"\\097bc\"").as_deref(), Some("abc"));
    assert_eq!(txt_rdata_text("\"\"").as_deref(), Some(""));
    // A resolver that gives the text bare: one token, taken as it is.
    assert_eq!(txt_rdata_text("abc123").as_deref(), Some("abc123"));
}

#[test]
fn a_txt_record_that_cant_be_read_is_no_value_at_all() {
    for data in [
        "",
        "\"abc",
        "\"abc\\\"",
        "\"a\\256\"",
        "\"a\\09\"",
        "\"ab\"x\"cd\"",
        "\"ab\" x",
        "ab cd",
        "ab\"cd",
        "ab\\cd",
        "\"a\u{0}b\"",
        "\"a\nb\"",
    ] {
        assert_eq!(txt_rdata_text(data), None, "{data:?}");
    }
    // A value that unescapes to a byte that isn't text is refused, not mangled.
    assert_eq!(txt_rdata_text("\"\\255\""), None);
}

#[test]
fn only_the_requests_own_value_proves_it_after_the_text_is_read() {
    let value = challenge_value([0xab; 32]);
    let split = format!("\"{}\" \"{}\"", &value[..32], &value[32..]);
    let read: Vec<String> = [split.as_str(), "\"v=spf1 -all\""]
        .iter()
        .filter_map(|data| txt_rdata_text(data))
        .collect();
    let values: Vec<&str> = read.iter().map(String::as_str).collect();
    assert!(proof_matches(&values, &value));
    assert!(!proof_matches(&values, &challenge_value([0xac; 32])));
    // The value in another case is another value.
    let upper = value.to_ascii_uppercase();
    assert!(!proof_matches(&[upper.as_str()], &value));
}

#[test]
fn a_pending_request_is_looked_at_every_minute_for_an_hour_then_every_fifteen() {
    assert_eq!(next_proof_check(NOW, None), NOW);
    assert_eq!(next_proof_check(NOW, Some(NOW + 5)), NOW + 5 + MINUTE);
    assert_eq!(
        next_proof_check(NOW, Some(NOW + HOUR - 1)),
        NOW + HOUR - 1 + MINUTE
    );
    assert_eq!(
        next_proof_check(NOW, Some(NOW + HOUR)),
        NOW + HOUR + 15 * MINUTE
    );
    // A clock that ran backwards never makes a check due before the one it follows.
    assert_eq!(next_proof_check(NOW, Some(NOW - HOUR)), NOW - HOUR + MINUTE);
}

#[test]
fn a_pending_request_expires_only_while_no_proof_has_been_taken_to_the_claim() {
    assert!(!request_expired(
        HostnameRequestState::Pending,
        false,
        NOW,
        NOW + 72 * HOUR - 1
    ));
    assert!(request_expired(
        HostnameRequestState::Pending,
        false,
        NOW,
        NOW + 72 * HOUR
    ));
    // Once its proof matched, the hostname's object may already have given the claim: only its answer decides.
    assert!(!request_expired(
        HostnameRequestState::Pending,
        true,
        NOW,
        NOW + 100 * HOUR
    ));
    for state in HostnameRequestState::ALL {
        if state != HostnameRequestState::Pending {
            assert!(
                !request_expired(state, false, NOW, NOW + 100 * HOUR),
                "{state:?}"
            );
        }
    }
}

#[test]
fn every_decision_reads_back_from_its_own_code_and_nothing_else_does() {
    for decision in ClaimDecision::ALL {
        assert_eq!(ClaimDecision::from_code(decision.code()), Some(decision));
    }
    let codes: std::collections::BTreeSet<&str> =
        ClaimDecision::ALL.iter().map(|d| d.code()).collect();
    assert_eq!(codes.len(), ClaimDecision::ALL.len());
    for other in ["", "Granted", "hostname_claimed ", "release_off"] {
        assert_eq!(ClaimDecision::from_code(other), None);
    }
}

#[test]
fn a_withdrawn_request_is_never_granted_whatever_the_record_says() {
    assert_eq!(
        decide_ask(&EMPTY, &ask("ws_a", "hnr_a", 0), true, NOW + 1),
        ClaimDecision::Withdrawn
    );
    assert_eq!(
        ClaimDecision::Withdrawn.code(),
        "hostname_request_withdrawn"
    );
    // Not withdrawn, it is exactly `decide_claim`.
    for record in [
        EMPTY,
        HostnameRecord {
            suspended: true,
            ..EMPTY
        },
        HostnameRecord {
            generation: 3,
            ..EMPTY
        },
    ] {
        let a = ask("ws_a", "hnr_a", 0);
        assert_eq!(
            decide_ask(&record, &a, false, NOW + 1),
            decide_claim(&record, &a, NOW + 1)
        );
    }
}

#[test]
fn withdrawing_a_claim_the_room_never_committed_frees_it_and_moves_the_generation() {
    let held = HostnameRecord {
        claim: Some(Claim {
            room: "ws_a",
            request: "hnr_a",
        }),
        generation: 4,
        ..EMPTY
    };
    let (after, outcome) = withdraw(&held, "ws_a", "hnr_a", NOW + 5);
    assert_eq!(outcome, Withdrawal::Freed);
    assert_eq!(after.claim, None);
    assert!(!after.ending);
    assert_eq!(after.last_freed_at, Some(NOW + 5));
    assert_eq!(after.generation, 5);
    // A claim a suspension set ending, for a request the room never committed, is freed the same way, and the
    // suspension stays.
    let ending = HostnameRecord {
        ending: true,
        suspended: true,
        ..held
    };
    let (after, outcome) = withdraw(&ending, "ws_a", "hnr_a", NOW + 6);
    assert_eq!(outcome, Withdrawal::Freed);
    assert_eq!(
        (after.claim, after.ending, after.suspended),
        (None, false, true)
    );
    // Every request made before the free is stale after it, the same room's included.
    assert_eq!(
        decide_claim(&after, &ask("ws_a", "hnr_b", 4), NOW + 7),
        ClaimDecision::Suspended
    );
}

#[test]
fn withdrawing_never_touches_anyone_elses_claim() {
    let held = HostnameRecord {
        claim: Some(Claim {
            room: "ws_a",
            request: "hnr_a",
        }),
        generation: 4,
        ..EMPTY
    };
    for (room, request) in [("ws_b", "hnr_a"), ("ws_a", "hnr_b"), ("ws_b", "hnr_b")] {
        let (after, outcome) = withdraw(&held, room, request, NOW + 5);
        assert_eq!(outcome, Withdrawal::HeldByOther, "{room} {request}");
        assert_eq!(after, held);
    }
    let (after, outcome) = withdraw(&EMPTY, "ws_a", "hnr_a", NOW + 5);
    assert_eq!(outcome, Withdrawal::NothingHeld);
    assert_eq!(after, EMPTY);
}

#[test]
fn a_removal_drops_a_request_nobody_was_asked_about_and_otherwise_ends_it_through_the_object() {
    use HostnameRequestState as S;
    assert_eq!(unmap(S::Pending, false, false), Unmap::Drop);
    // Its proof was taken to the hostname's object, which may have given the claim: the room withdraws it there
    // before the request is over.
    assert_eq!(unmap(S::Pending, true, false), Unmap::Withdraw);
    // A claim the room committed: it stops serving on the name, and the claim ends as any claim does.
    assert_eq!(unmap(S::Claimed, true, true), Unmap::EndClaim);
    // A claimed request with no committed claim can't happen; if it did, only the object knows, so it is withdrawn.
    assert_eq!(unmap(S::Claimed, true, false), Unmap::Withdraw);
    // Ending already, or over: nothing more.
    for state in [S::Ending, S::Refused, S::Expired, S::Ended] {
        for (proved, claimed) in [(false, false), (true, false), (true, true)] {
            assert_eq!(unmap(state, proved, claimed), Unmap::Nothing, "{state:?}");
        }
    }
}

#[test]
fn the_room_records_the_objects_answer_only_for_a_request_still_pending() {
    use HostnameRequestState as S;
    assert_eq!(
        after_ask(S::Pending, ClaimDecision::Granted),
        Some(AskOutcome {
            state: S::Claimed,
            end_reason: None
        })
    );
    assert_eq!(
        after_ask(S::Pending, ClaimDecision::Expired),
        Some(AskOutcome {
            state: S::Expired,
            end_reason: Some("hostname_request_expired")
        })
    );
    for refusal in [
        ClaimDecision::HeldElsewhere,
        ClaimDecision::Unproven,
        ClaimDecision::StaleChallenge,
        ClaimDecision::Withdrawn,
    ] {
        assert_eq!(
            after_ask(S::Pending, refusal),
            Some(AskOutcome {
                state: S::Refused,
                end_reason: Some(refusal.code())
            })
        );
    }
    // A request the room has since removed, or that a notice set ending, records nothing: a claim given for it is
    // withdrawn, never committed.
    for state in [S::Claimed, S::Ending, S::Refused, S::Expired, S::Ended] {
        assert_eq!(after_ask(state, ClaimDecision::Granted), None, "{state:?}");
    }
}

#[test]
fn an_answer_that_may_hide_a_claim_given_for_this_request_goes_ending_so_it_is_withdrawn() {
    use HostnameRequestState as S;
    // Suspended and ending are decided before whose the claim is, so the object may hold one it gave this very request
    // on an ask whose answer was lost. Refused would leave that claim held for ever: the request goes `ending`, never
    // committed, and the job withdraws it, which frees only a claim for exactly this room and request.
    for decision in [ClaimDecision::Suspended, ClaimDecision::Ending] {
        assert_eq!(
            after_ask(S::Pending, decision),
            Some(AskOutcome {
                state: S::Ending,
                end_reason: Some(decision.code())
            }),
            "{decision:?}"
        );
    }
    // The retried ask that meets the suspension before its notice does: the object holds this request's claim, and
    // answers suspended.
    let given = HostnameRecord {
        claim: Some(Claim {
            room: "ws_a",
            request: "hnr_a",
        }),
        ..EMPTY
    };
    let (suspended, _) = suspend(&given, NOW + MINUTE);
    assert_eq!(
        decide_ask(
            &suspended,
            &ask("ws_a", "hnr_a", 0),
            false,
            NOW + 2 * MINUTE
        ),
        ClaimDecision::Suspended
    );
    // Withdrawn, it is freed, and the name is free again once the suspension is lifted.
    let (freed, outcome) = withdraw(&suspended, "ws_a", "hnr_a", NOW + 3 * MINUTE);
    assert_eq!(outcome, Withdrawal::Freed);
    assert!(freed.claim.is_none());
    assert!(lift(&freed, NOW + 4 * MINUTE).claim.is_none());
}

#[test]
fn an_unanswered_ask_or_withdrawal_waits_longer_each_time_up_to_an_hour_and_never_gives_up() {
    use podster_core::hostname_requests::{retry_wait_ms, RETRY_FIRST_MS, RETRY_MAX_MS};
    assert_eq!((RETRY_FIRST_MS, RETRY_MAX_MS), (MINUTE, HOUR));
    // The first retry waits a minute; each wait is then as long as the time already spent, so it doubles.
    let since = NOW;
    let mut at = since;
    let mut waits = Vec::new();
    for _ in 0..9 {
        let wait = retry_wait_ms(since, at);
        waits.push(wait / MINUTE);
        at += wait;
    }
    assert_eq!(waits, [1, 1, 2, 4, 8, 16, 32, 60, 60]);
    // A day, or a year, later it still tries every hour.
    assert_eq!(retry_wait_ms(since, since + 365 * 24 * HOUR), HOUR);
    // A last try recorded before the request's last change, as a clock set back would make, waits the shortest.
    assert_eq!(retry_wait_ms(since, since - HOUR), MINUTE);
}

#[test]
fn podsters_own_domains_and_the_content_domains_are_reserved_with_every_name_under_them() {
    let rules = ["com", "net", "dev", "site", "example"];
    for name in [
        "podster.dev",
        "app.podster.dev",
        "opster.dev",
        "x.opster.dev",
        "podster.site",
        "anything.podster.site",
        "a.b.content.example",
    ] {
        assert_eq!(
            mappable(name, "content.example", &rules, false, 0),
            Err(HostnameRefusal::Reserved),
            "{name}"
        );
    }
    // Neighbours that only end in the same letters aren't under them.
    for name in ["mypodster.dev", "notopster.dev", "xpodster.site"] {
        assert_eq!(
            mappable(name, "content.example", &rules, false, 0).as_deref(),
            Ok(name),
            "{name}"
        );
    }
    assert_eq!(
        RESERVED_DOMAINS,
        ["podster.dev", "opster.dev", "podster.site"]
    );
}

#[test]
fn a_room_asks_for_at_most_five_new_hostnames_in_any_hour() {
    use podster_core::hostname_requests::{request_rate_allows, MAX_REQUESTS_PER_HOUR};
    assert_eq!(MAX_REQUESTS_PER_HOUR, 5);
    for made in 0..5 {
        assert!(request_rate_allows(made), "{made}");
    }
    for made in [5, 6, 100] {
        assert!(!request_rate_allows(made), "{made}");
    }
}

/// What a room's owner is told of a request's setup (2026-11-25): one word for every state, and Cloudflare's `active`
/// counts only for a claimed request.
#[test]
fn setup_status_is_fixed_by_the_state_and_cloudflares_active() {
    use HostnameRequestState::*;
    use HostnameSetup as S;
    let cases = [
        (Pending, false, S::ProofPending),
        (Pending, true, S::ProofPending),
        (Claimed, false, S::ProviderPending),
        (Claimed, true, S::Active),
        (Ending, false, S::Ended),
        (Ending, true, S::Ended),
        (Ended, false, S::Ended),
        (Ended, true, S::Ended),
        (Refused, false, S::Failed),
        (Refused, true, S::Failed),
        (Expired, false, S::Failed),
        (Expired, true, S::Failed),
    ];
    for (state, active, expected) in cases {
        assert_eq!(setup_status(state, active), expected, "{state:?} {active}");
    }
    let names: Vec<&str> = HostnameSetup::ALL.iter().map(|s| s.name()).collect();
    assert_eq!(
        names,
        [
            "proof_pending",
            "provider_pending",
            "active",
            "ended",
            "failed"
        ]
    );
}

/// The CNAME target is the content domain's fallback origin, and nothing else.
#[test]
fn cname_target_is_the_content_domains_fallback() {
    assert_eq!(cname_target("podster.site"), "fallback.podster.site");
    assert_eq!(CNAME_TARGET_LABEL, "fallback");
}
