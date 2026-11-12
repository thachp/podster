//! A custom hostname (ADR 0010, custom domains): normalization, refusals, the challenge, one claim per hostname that
//! never transfers, the recheck's two ways of failing, and suspension outliving claims.

use podster_core::hostnames::*;

const CONTENT: &str = "opster.dev";
const SUFFIXES: &[&str] = &["com", "co.uk", "github.io", "dev"];
const HOUR: i64 = 60 * 60 * 1000;
const DAY: i64 = 24 * HOUR;
const NOW: i64 = 1_000 * DAY;

#[test]
fn every_spelling_of_a_name_is_one_name() {
    for (input, expected) in [
        ("example.com", "example.com"),
        ("Example.COM", "example.com"),
        ("example.com.", "example.com"),
        ("APP.Example.Com.", "app.example.com"),
        ("bücher.example", "xn--bcher-kva.example"),
        ("BÜCHER.example", "xn--bcher-kva.example"),
        ("xn--bcher-kva.example", "xn--bcher-kva.example"),
        ("a-b.example", "a-b.example"),
    ] {
        assert_eq!(normalize(input), Ok(expected.to_owned()), "{input}");
    }
}

#[test]
fn what_isnt_a_hostname_is_refused() {
    let label63 = "a".repeat(63);
    assert!(normalize(&format!("{label63}.com")).is_ok());
    assert_eq!(
        normalize(&format!("{}.com", "a".repeat(64))),
        Err(HostnameRefusal::Invalid)
    );
    // 253 characters in all, and not one more.
    let long = format!("{l}.{l}.{l}.{}", "a".repeat(61), l = label63);
    assert_eq!(long.len(), 253);
    assert!(normalize(&long).is_ok());
    assert_eq!(
        normalize(&format!("a{long}")),
        Err(HostnameRefusal::Invalid)
    );
    for bad in [
        "",
        ".",
        "..",
        "a..b",
        "example.com..",
        " example.com",
        "example .com",
        "-a.com",
        "a-.com",
        "a_b.com",
        "a/b.com",
        "a@b.com",
        "exa\tmple.com",
        "a:b.com",
    ] {
        assert_eq!(normalize(bad), Err(HostnameRefusal::Invalid), "{bad:?}");
    }
    for wildcard in ["*.example.com", "*", "a*.example.com", "*.EXAMPLE.com."] {
        assert_eq!(
            normalize(wildcard),
            Err(HostnameRefusal::Wildcard),
            "{wildcard}"
        );
    }
    for ip in [
        "192.168.0.1",
        "192.168.0.1.",
        "[::1]",
        "::1",
        "10.0.0.256",
        "example.123",
        "1.2.3.4",
    ] {
        let found = normalize(ip);
        assert!(
            matches!(
                found,
                Err(HostnameRefusal::IpAddress) | Err(HostnameRefusal::Invalid)
            ),
            "{ip}: {found:?}"
        );
    }
    assert_eq!(normalize("192.168.0.1"), Err(HostnameRefusal::IpAddress));
    assert_eq!(normalize("example.123"), Err(HostnameRefusal::IpAddress));
}

#[test]
fn podsters_own_names_the_content_domain_and_public_suffixes_are_refused() {
    let map = |name: &str| mappable(name, CONTENT, SUFFIXES, false, 0);
    for reserved in [
        "podster.dev",
        "app.podster.dev",
        "PODSTER.DEV.",
        "a.b.podster.dev",
        "opster.dev",
        "room.opster.dev",
        "Opster.Dev.",
    ] {
        assert_eq!(map(reserved), Err(HostnameRefusal::Reserved), "{reserved}");
    }
    for suffix in ["co.uk", "github.io", "CO.UK."] {
        assert_eq!(map(suffix), Err(HostnameRefusal::PublicSuffix), "{suffix}");
    }
    for single in ["localhost", "example", "dev"] {
        assert_eq!(map(single), Err(HostnameRefusal::SingleLabel), "{single}");
    }
    // A name that only ends like Podster's isn't under it.
    assert_eq!(map("notpodster.dev"), Ok("notpodster.dev".to_owned()));
    assert_eq!(map("myopster.dev"), Ok("myopster.dev".to_owned()));
    assert_eq!(map("app.example.co.uk"), Ok("app.example.co.uk".to_owned()));
    assert_eq!(
        mappable("app.example.com", CONTENT, SUFFIXES, true, 0),
        Err(HostnameRefusal::Suspended)
    );
    assert_eq!(
        mappable("app.example.com", CONTENT, SUFFIXES, false, 1),
        Err(HostnameRefusal::RoomLimit)
    );
    assert_eq!(HostnameRefusal::Reserved.code(), "hostname_reserved");
}

#[test]
fn the_challenge_is_a_room_bound_value_any_one_of_which_proves() {
    assert_eq!(
        challenge_record_name("app.example.com"),
        "_podster-challenge.app.example.com"
    );
    let value = challenge_value([0xab; 32]);
    assert_eq!(value.len(), 64);
    assert!(value
        .bytes()
        .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));
    assert_ne!(challenge_value([1; 32]), challenge_value([2; 32]));
    assert!(proof_matches(&["other-room-value", &value], &value));
    assert!(!proof_matches(&["other-room-value"], &value));
    assert!(!proof_matches(&[&value.to_uppercase()], &value));
    assert!(!proof_matches(&[""], ""));
    assert!(!proof_matches(&[], &value));
}

#[test]
fn a_pending_request_holds_nothing_and_is_gone_after_72_hours() {
    assert!(!pending_expired(NOW, NOW + 72 * HOUR - 1));
    assert!(pending_expired(NOW, NOW + 72 * HOUR));
    // Any number of rooms may be pending: the hostname's object holds no pending request, so none blocks another.
    let empty = HostnameRecord {
        claim: None,
        suspended: false,
        last_freed_at: None,
    };
    for room in ["ws_a", "ws_b", "ws_c"] {
        let unproven = ClaimAsk {
            room,
            request: "hr_1",
            requested_at: NOW,
            proof_matched: false,
        };
        assert_eq!(
            decide_claim(&empty, &unproven, NOW + HOUR),
            ClaimDecision::Unproven
        );
    }
    let late = ClaimAsk {
        room: "ws_a",
        request: "hr_1",
        requested_at: NOW,
        proof_matched: true,
    };
    assert_eq!(
        decide_claim(&empty, &late, NOW + 72 * HOUR),
        ClaimDecision::Expired
    );
}

#[test]
fn one_hostname_one_room_and_asking_again_gets_the_same_answer() {
    let empty = HostnameRecord {
        claim: None,
        suspended: false,
        last_freed_at: None,
    };
    let a = ClaimAsk {
        room: "ws_a",
        request: "hr_a",
        requested_at: NOW,
        proof_matched: true,
    };
    let b = ClaimAsk {
        room: "ws_b",
        request: "hr_b",
        requested_at: NOW,
        proof_matched: true,
    };
    assert_eq!(decide_claim(&empty, &a, NOW + 1), ClaimDecision::Granted);
    let held = HostnameRecord {
        claim: Some(Claim {
            room: "ws_a",
            request: "hr_a",
        }),
        ..empty
    };
    assert_eq!(decide_claim(&held, &a, NOW + 2), ClaimDecision::Granted);
    assert_eq!(
        decide_claim(&held, &b, NOW + 2),
        ClaimDecision::HeldElsewhere
    );
    // The same room under another request doesn't get a second claim.
    let again = ClaimAsk {
        request: "hr_a2",
        ..a
    };
    assert_eq!(
        decide_claim(&held, &again, NOW + 2),
        ClaimDecision::HeldElsewhere
    );
    assert_eq!(ClaimDecision::HeldElsewhere.code(), "hostname_claimed");
}

#[test]
fn a_claim_never_transfers_and_is_freed_only_when_cloudflare_says_gone() {
    // Room A's claim ends: its host is cleared first, then the custom hostname is read until gone.
    assert!(!may_free_claim(false, true));
    assert!(!may_free_claim(true, false));
    assert!(!may_free_claim(false, false));
    assert!(may_free_claim(true, true));
    let held = HostnameRecord {
        claim: Some(Claim {
            room: "ws_a",
            request: "hr_a",
        }),
        suspended: false,
        last_freed_at: None,
    };
    let freed_at = NOW + 10 * HOUR;
    let freed = free(&held, freed_at);
    assert_eq!(freed.claim, None);
    // Room B, whose DNS record still points at Podster from before, has a challenge from before the free: refused.
    let stale = ClaimAsk {
        room: "ws_b",
        request: "hr_b",
        requested_at: freed_at - 1,
        proof_matched: true,
    };
    assert_eq!(
        decide_claim(&freed, &stale, freed_at + 1),
        ClaimDecision::StaleChallenge
    );
    let at_free = ClaimAsk {
        requested_at: freed_at,
        ..stale
    };
    assert_eq!(
        decide_claim(&freed, &at_free, freed_at + 1),
        ClaimDecision::StaleChallenge
    );
    // The same room is no different: a later claim needs a new challenge with a new value.
    let same_room = ClaimAsk {
        room: "ws_a",
        request: "hr_a",
        requested_at: NOW,
        proof_matched: true,
    };
    assert_eq!(
        decide_claim(&freed, &same_room, freed_at + 1),
        ClaimDecision::StaleChallenge
    );
    let fresh = ClaimAsk {
        room: "ws_b",
        request: "hr_b2",
        requested_at: freed_at + 1,
        proof_matched: true,
    };
    assert_eq!(
        decide_claim(&freed, &fresh, freed_at + 2),
        ClaimDecision::Granted
    );
}

#[test]
fn a_custom_host_serves_only_when_the_room_and_the_claim_agree() {
    let claim = Some(Claim {
        room: "ws_a",
        request: "hr_a",
    });
    assert!(custom_host_may_serve(true, claim, "ws_a"));
    assert!(!custom_host_may_serve(false, claim, "ws_a"));
    assert!(!custom_host_may_serve(true, claim, "ws_b"));
    assert!(!custom_host_may_serve(true, None, "ws_a"));
    assert!(routing_may_start(true, "active"));
    assert!(!routing_may_start(true, "pending"));
    assert!(!routing_may_start(false, "active"));
    assert_eq!(cloudflare_status_ends_claim("moved"), Some(ClaimEnd::Moved));
    assert_eq!(cloudflare_status_ends_claim("active"), None);
}

#[test]
fn the_recheck_keeps_a_definite_no_apart_from_a_resolver_error() {
    let fresh = ProofHistory {
        last_success_at: NOW,
        definite_no_since: None,
    };
    let keep = |h| RecheckDecision::Keep(h);
    // A match resets both clocks.
    let mid = ProofHistory {
        last_success_at: NOW,
        definite_no_since: Some(NOW + DAY),
    };
    assert_eq!(
        recheck_claim(mid, RecheckOutcome::Match, NOW + 2 * DAY),
        keep(ProofHistory {
            last_success_at: NOW + 2 * DAY,
            definite_no_since: None
        })
    );
    // One definite no starts the span; a second less than 24 hours later doesn't end it, one 24 hours later does.
    let first = recheck_claim(fresh, RecheckOutcome::DefiniteNo, NOW + DAY);
    let started = ProofHistory {
        last_success_at: NOW,
        definite_no_since: Some(NOW + DAY),
    };
    assert_eq!(first, keep(started));
    assert_eq!(
        recheck_claim(started, RecheckOutcome::DefiniteNo, NOW + 2 * DAY - 1),
        keep(started)
    );
    assert_eq!(
        recheck_claim(started, RecheckOutcome::DefiniteNo, NOW + 2 * DAY),
        RecheckDecision::End(ClaimEnd::ChallengeRemoved)
    );
    // A resolver error in between neither resets nor ends it.
    assert_eq!(
        recheck_claim(started, RecheckOutcome::ResolverError, NOW + 2 * DAY),
        keep(started)
    );
    // Resolver errors alone never end a claim inside 7 days, and do at 7 days with no success.
    let mut history = fresh;
    for day in 1..7 {
        match recheck_claim(history, RecheckOutcome::ResolverError, NOW + day * DAY) {
            RecheckDecision::Keep(h) => history = h,
            ended => unreachable!("day {day}: {ended:?}"),
        }
    }
    assert_eq!(
        recheck_claim(history, RecheckOutcome::ResolverError, NOW + 7 * DAY - 1),
        keep(history)
    );
    assert_eq!(
        recheck_claim(history, RecheckOutcome::ResolverError, NOW + 7 * DAY),
        RecheckDecision::End(ClaimEnd::ProofLapsed)
    );
    assert!(!recheck_due(NOW, NOW + DAY - 1));
    assert!(recheck_due(NOW, NOW + DAY));
    assert_eq!(
        ClaimEnd::ChallengeRemoved.code(),
        "hostname_challenge_removed"
    );
}

#[test]
fn suspension_outlives_every_claim_and_lifting_it_restores_nothing() {
    let held = HostnameRecord {
        claim: Some(Claim {
            room: "ws_a",
            request: "hr_a",
        }),
        suspended: false,
        last_freed_at: None,
    };
    let (suspended, plan) = suspend(&held);
    assert!(suspended.suspended);
    assert_eq!(plan.tell_room, Some("ws_a"));
    // While suspended nobody gets a claim, not even the room that had it, and nobody may start a challenge.
    let a = ClaimAsk {
        room: "ws_a",
        request: "hr_a",
        requested_at: NOW,
        proof_matched: true,
    };
    assert_eq!(
        decide_claim(&suspended, &a, NOW + 1),
        ClaimDecision::Suspended
    );
    assert_eq!(
        mappable("app.example.com", CONTENT, SUFFIXES, suspended.suspended, 0),
        Err(HostnameRefusal::Suspended)
    );
    // The claim ends as any claim does; the suspension stays.
    let freed = free(&suspended, NOW + HOUR);
    assert!(freed.suspended);
    assert_eq!(freed.claim, None);
    let b = ClaimAsk {
        room: "ws_b",
        request: "hr_b",
        requested_at: NOW + 2 * HOUR,
        proof_matched: true,
    };
    assert_eq!(
        decide_claim(&freed, &b, NOW + 3 * HOUR),
        ClaimDecision::Suspended
    );
    // Lifting it restores nothing: no claim comes back, and an old challenge is still stale.
    let lifted = lift(&freed);
    assert!(!lifted.suspended);
    assert_eq!(lifted.claim, None);
    assert_eq!(
        decide_claim(&lifted, &a, NOW + 3 * HOUR),
        ClaimDecision::StaleChallenge
    );
    assert_eq!(
        decide_claim(&lifted, &b, NOW + 3 * HOUR),
        ClaimDecision::Granted
    );
    // A hostname with no claim, suspended, tells no room.
    assert_eq!(suspend(&lifted).1.tell_room, None);
}
