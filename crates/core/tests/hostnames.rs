//! A custom hostname (ADR 0010, custom domains): normalization, refusals, the Public Suffix List's rules, the challenge,
//! one claim per hostname that never transfers, the recheck's two ways of failing, and suspension ending a claim and
//! outliving it.

use podster_core::hostnames::*;

const CONTENT: &str = "opster.dev";
/// Enough of the list's shape: plain rules, a wildcard and its exception.
const RULES: &[&str] = &[
    "com",
    "uk",
    "co.uk",
    "io",
    "github.io",
    "dev",
    "example",
    "ck",
    "*.ck",
    "!www.ck",
];
const HOUR: i64 = 60 * 60 * 1000;
const DAY: i64 = 24 * HOUR;
const NOW: i64 = 1_000 * DAY;

const EMPTY: HostnameRecord = HostnameRecord {
    claim: None,
    ending: false,
    suspended: false,
    last_freed_at: None,
    last_suspended_at: None,
    last_lifted_at: None,
    generation: 0,
};

fn map(name: &str) -> Result<String, HostnameRefusal> {
    mappable(name, CONTENT, RULES, false, 0)
}

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
}

#[test]
fn ip_literals_and_names_that_read_as_numbers_are_refused() {
    for ip in [
        "192.168.0.1",
        "192.168.0.1.",
        "1.2.3.4",
        "example.123",
        "0x4",
        "1.2.3.0x4",
        "a.0X1F",
        "a.0x",
        "a.017",
        "a.0",
    ] {
        assert_eq!(normalize(ip), Err(HostnameRefusal::IpAddress), "{ip}");
    }
    for ip in ["[::1]", "::1", "10.0.0.256"] {
        let found = normalize(ip);
        assert!(
            matches!(
                found,
                Err(HostnameRefusal::IpAddress) | Err(HostnameRefusal::Invalid)
            ),
            "{ip}: {found:?}"
        );
    }
    for name in ["a.0xg", "a.1a", "0x4.example.com", "a.x0"] {
        assert!(normalize(name).is_ok(), "{name}");
    }
}

#[test]
fn podsters_own_names_and_the_content_domain_are_refused_and_a_bad_content_domain_fails_closed() {
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
    assert_eq!(map("notpodster.dev"), Ok("notpodster.dev".to_owned()));
    assert_eq!(map("myopster.dev"), Ok("myopster.dev".to_owned()));
    assert_eq!(
        mappable("room.opster.dev", "OPSTER.DEV.", RULES, false, 0),
        Err(HostnameRefusal::Reserved)
    );
    for bad in ["", "dev", "*.opster.dev", "opster..dev", " opster.dev"] {
        assert_eq!(
            mappable("app.example.com", bad, RULES, false, 0),
            Err(HostnameRefusal::Unclassified),
            "{bad:?}"
        );
    }
    for single in ["localhost", "example", "dev"] {
        assert_eq!(map(single), Err(HostnameRefusal::SingleLabel), "{single}");
    }
    assert_eq!(
        mappable("app.example.com", CONTENT, RULES, true, 0),
        Err(HostnameRefusal::Suspended)
    );
    assert_eq!(
        mappable("app.example.com", CONTENT, RULES, false, 1),
        Err(HostnameRefusal::RoomLimit)
    );
    assert_eq!(HostnameRefusal::Unclassified.code(), "hostname_unavailable");
}

#[test]
fn the_public_suffix_lists_plain_wildcard_and_exception_rules_hold() {
    for suffix in ["co.uk", "github.io", "CO.UK.", "foo.ck", "bar.ck"] {
        assert_eq!(map(suffix), Err(HostnameRefusal::PublicSuffix), "{suffix}");
    }
    for ok in [
        "app.example.co.uk",
        "me.github.io",
        "www.ck",
        "a.www.ck",
        "app.foo.ck",
        "example.com",
    ] {
        assert!(map(ok).is_ok(), "{ok}");
    }
    assert_eq!(map("app.example.zz"), Err(HostnameRefusal::Unclassified));
    assert_eq!(
        mappable("app.example.com", CONTENT, &[], false, 0),
        Err(HostnameRefusal::Unclassified)
    );
    for bad in [
        &["com", "a..b"][..],
        &["com", "!x"][..],
        &["com", "a.*.b"][..],
        &["com", "*"][..],
    ] {
        assert_eq!(
            mappable("app.example.com", CONTENT, bad, false, 0),
            Err(HostnameRefusal::Unclassified),
            "{bad:?}"
        );
    }
    assert_eq!(
        HostnameRefusal::PublicSuffix.code(),
        "hostname_public_suffix"
    );
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
    for room in ["ws_a", "ws_b", "ws_c"] {
        let unproven = ClaimAsk {
            room,
            request: "hr_1",
            requested_at: NOW,
            proof_matched: false,
            generation: 0,
        };
        assert_eq!(
            decide_claim(&EMPTY, &unproven, NOW + HOUR),
            ClaimDecision::Unproven
        );
    }
    let late = ClaimAsk {
        room: "ws_a",
        request: "hr_1",
        requested_at: NOW,
        proof_matched: true,
        generation: 0,
    };
    assert_eq!(
        decide_claim(&EMPTY, &late, NOW + 72 * HOUR),
        ClaimDecision::Expired
    );
}

#[test]
fn one_hostname_one_room_and_asking_again_gets_the_same_answer() {
    let a = ClaimAsk {
        room: "ws_a",
        request: "hr_a",
        requested_at: NOW,
        proof_matched: true,
        generation: 0,
    };
    let b = ClaimAsk {
        room: "ws_b",
        request: "hr_b",
        requested_at: NOW,
        proof_matched: true,
        generation: 0,
    };
    assert_eq!(decide_claim(&EMPTY, &a, NOW + 1), ClaimDecision::Granted);
    let held = HostnameRecord {
        claim: Some(Claim {
            room: "ws_a",
            request: "hr_a",
        }),
        ..EMPTY
    };
    assert_eq!(decide_claim(&held, &a, NOW + 2), ClaimDecision::Granted);
    assert_eq!(
        decide_claim(&held, &b, NOW + 2),
        ClaimDecision::HeldElsewhere
    );
    let again = ClaimAsk {
        request: "hr_a2",
        ..a
    };
    assert_eq!(
        decide_claim(&held, &again, NOW + 2),
        ClaimDecision::HeldElsewhere
    );
    let ending = end_claim(&held);
    assert!(ending.ending);
    assert_eq!(decide_claim(&ending, &a, NOW + 3), ClaimDecision::Ending);
    assert_eq!(decide_claim(&ending, &b, NOW + 3), ClaimDecision::Ending);
    assert!(!end_claim(&EMPTY).ending);
    assert_eq!(ClaimDecision::HeldElsewhere.code(), "hostname_claimed");
}

#[test]
fn a_claim_never_transfers_and_is_freed_only_when_cloudflare_says_gone() {
    assert!(!may_free_claim(false, true));
    assert!(!may_free_claim(true, false));
    assert!(!may_free_claim(false, false));
    assert!(may_free_claim(true, true));
    let held = end_claim(&HostnameRecord {
        claim: Some(Claim {
            room: "ws_a",
            request: "hr_a",
        }),
        ..EMPTY
    });
    let freed_at = NOW + 10 * HOUR;
    let freed = free(&held, freed_at);
    assert_eq!(freed.claim, None);
    assert!(!freed.ending);
    let stale = ClaimAsk {
        room: "ws_b",
        request: "hr_b",
        requested_at: freed_at - 1,
        proof_matched: true,
        generation: 0,
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
    let same_room = ClaimAsk {
        room: "ws_a",
        request: "hr_a",
        requested_at: NOW,
        proof_matched: true,
        generation: 0,
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
        generation: freed.generation,
    };
    assert_eq!(
        decide_claim(&freed, &fresh, freed_at + 2),
        ClaimDecision::Granted
    );
}

#[test]
fn a_custom_host_serves_only_on_a_live_unsuspended_claim_its_room_holds() {
    let held = HostnameRecord {
        claim: Some(Claim {
            room: "ws_a",
            request: "hr_a",
        }),
        ..EMPTY
    };
    assert!(custom_host_may_serve(true, &held, "ws_a"));
    assert!(!custom_host_may_serve(false, &held, "ws_a"));
    assert!(!custom_host_may_serve(true, &held, "ws_b"));
    assert!(!custom_host_may_serve(true, &EMPTY, "ws_a"));
    let (suspended, _) = suspend(&held, NOW);
    assert!(suspended.claim.is_some());
    assert!(!custom_host_may_serve(true, &suspended, "ws_a"));
    assert!(!custom_host_may_serve(true, &end_claim(&held), "ws_a"));
    assert!(!custom_host_may_serve(
        true,
        &HostnameRecord {
            suspended: true,
            ..held
        },
        "ws_a"
    ));
    assert!(routing_may_start(&held, "ws_a", "active"));
    assert!(!routing_may_start(&held, "ws_a", "pending"));
    assert!(!routing_may_start(&held, "ws_b", "active"));
    assert!(!routing_may_start(&EMPTY, "ws_a", "active"));
    // An ending or suspended claim can't start routing, though `claim.room` still names the room.
    assert!(!routing_may_start(&end_claim(&held), "ws_a", "active"));
    assert!(!routing_may_start(&suspend(&held, NOW).0, "ws_a", "active"));
    assert_eq!(cloudflare_status_ends_claim("moved"), Some(ClaimEnd::Moved));
    assert_eq!(cloudflare_status_ends_claim("active"), None);
}

#[test]
fn the_recheck_keeps_a_definite_no_apart_from_a_resolver_error() {
    let fresh = ProofHistory {
        last_success_at: NOW,
        definite_no_since: None,
    };
    let keep = RecheckDecision::Keep;
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
    // A resolver error neither counts as a no nor resets the count: two noes a day apart end it with errors between.
    assert_eq!(
        recheck_claim(started, RecheckOutcome::ResolverError, NOW + DAY + HOUR),
        keep(started)
    );
    assert_eq!(
        recheck_claim(started, RecheckOutcome::ResolverError, NOW + 2 * DAY),
        keep(started)
    );
    let mut history = fresh;
    for day in 1..7 {
        match recheck_claim(history, RecheckOutcome::ResolverError, NOW + day * DAY) {
            RecheckDecision::Keep(h) => history = h,
            ended => unreachable!("day {day}: {ended:?}"),
        }
    }
    assert_eq!(history.definite_no_since, None);
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
fn suspension_ends_the_claim_outlives_it_and_lifting_it_restores_nothing() {
    let held = HostnameRecord {
        claim: Some(Claim {
            room: "ws_a",
            request: "hr_a",
        }),
        ..EMPTY
    };
    let (suspended, plan) = suspend(&held, NOW);
    assert!(suspended.suspended);
    assert!(suspended.ending, "suspending a hostname ends its claim");
    assert_eq!(plan.tell_room, Some("ws_a"));
    let a = ClaimAsk {
        room: "ws_a",
        request: "hr_a",
        requested_at: NOW,
        proof_matched: true,
        generation: 0,
    };
    assert_eq!(
        decide_claim(&suspended, &a, NOW + 1),
        ClaimDecision::Suspended
    );
    assert_eq!(
        mappable("app.example.com", CONTENT, RULES, suspended.suspended, 0),
        Err(HostnameRefusal::Suspended)
    );
    // Lifted before the claim was freed: the claim is still ending, and serves and grants nothing.
    let early = lift(&suspended, NOW + 2);
    assert!(!early.suspended);
    assert_eq!(decide_claim(&early, &a, NOW + 2), ClaimDecision::Ending);
    assert!(!custom_host_may_serve(true, &early, "ws_a"));
    let freed = free(&suspended, NOW + HOUR);
    assert!(freed.suspended);
    let b = ClaimAsk {
        room: "ws_b",
        request: "hr_b",
        requested_at: NOW + 2 * HOUR,
        proof_matched: true,
        generation: 0,
    };
    assert_eq!(
        decide_claim(&freed, &b, NOW + 3 * HOUR),
        ClaimDecision::Suspended
    );
    let lifted = lift(&freed, NOW + 3 * HOUR);
    assert!(!lifted.suspended);
    assert_eq!(lifted.claim, None);
    assert_eq!(
        decide_claim(&lifted, &a, NOW + 4 * HOUR),
        ClaimDecision::StaleChallenge
    );
    // A request made while the name was suspended doesn't count after the lift; only one made after it does.
    assert_eq!(
        decide_claim(&lifted, &b, NOW + 4 * HOUR),
        ClaimDecision::StaleChallenge
    );
    let after = ClaimAsk {
        request: "hr_b2",
        requested_at: NOW + 3 * HOUR + 1,
        generation: lifted.generation,
        ..b
    };
    assert_eq!(
        decide_claim(&lifted, &after, NOW + 4 * HOUR),
        ClaimDecision::Granted
    );
    assert_eq!(suspend(&lifted, NOW).1.tell_room, None);
    assert!(!suspend(&lifted, NOW).0.ending);
}

#[test]
fn a_suspension_voids_every_pending_request_for_the_name() {
    // A request made before the suspension of a name nobody had claimed yet.
    let pending = ClaimAsk {
        room: "ws_a",
        request: "hr_a",
        requested_at: NOW,
        proof_matched: true,
        generation: 0,
    };
    let (suspended, plan) = suspend(&EMPTY, NOW + HOUR);
    assert_eq!(plan.tell_room, None);
    assert_eq!(
        decide_claim(&suspended, &pending, NOW + 2 * HOUR),
        ClaimDecision::Suspended
    );
    // Lifted: that request is void; a fresh one made after the suspension is granted.
    let lifted = lift(&suspended, NOW + 2 * HOUR);
    assert_eq!(
        decide_claim(&lifted, &pending, NOW + 3 * HOUR),
        ClaimDecision::StaleChallenge
    );
    let at = ClaimAsk {
        requested_at: NOW + HOUR,
        ..pending
    };
    assert_eq!(
        decide_claim(&lifted, &at, NOW + 3 * HOUR),
        ClaimDecision::StaleChallenge
    );
    let fresh = ClaimAsk {
        request: "hr_a2",
        requested_at: NOW + 2 * HOUR + 1,
        generation: lifted.generation,
        ..pending
    };
    assert_eq!(
        decide_claim(&lifted, &fresh, NOW + 3 * HOUR),
        ClaimDecision::Granted
    );
    // Freeing a claim later keeps the suspension's mark.
    assert_eq!(
        free(&lifted, NOW + 4 * HOUR).last_suspended_at,
        Some(NOW + HOUR)
    );
}

#[test]
fn comment_and_blank_lines_are_skipped_by_the_lists_format_and_refused_as_rules() {
    let list = "// ===BEGIN ICANN DOMAINS===\n\ncom\n// a comment\n  co.uk  \n*.ck\n!www.ck\nio extra words\n";
    assert_eq!(
        public_suffix_rules(list),
        ["com", "co.uk", "*.ck", "!www.ck", "io"]
    );
    let rules = public_suffix_rules(list);
    assert!(mappable("app.example.com", CONTENT, &rules, false, 0).is_ok());
    // Passed straight in as a rule, a comment or a blank isn't read silently: it fails closed.
    for bad in ["// a comment", "", " ", "com // trailing", "a b"] {
        assert_eq!(
            mappable("app.example.com", CONTENT, &["com", bad], false, 0),
            Err(HostnameRefusal::Unclassified),
            "{bad:?}"
        );
    }
}

#[test]
fn full_width_digits_are_still_an_address_after_idna() {
    for ip in ["a.１２３", "１.２.３.４", "１９２.１６８.０.１", "a.０ｘ４"] {
        assert_eq!(normalize(ip), Err(HostnameRefusal::IpAddress), "{ip}");
    }
}

#[test]
fn a_request_made_while_suspended_never_counts_and_the_marks_only_move_forward() {
    // Suspended at 100, a request stamped at 150 under the suspended generation, lifted at 200, proof at 300: refused.
    let (suspended, _) = suspend(&EMPTY, 100);
    let during = ClaimAsk {
        room: "ws_a",
        request: "hr_a",
        requested_at: 150,
        proof_matched: true,
        generation: suspended.generation,
    };
    assert_eq!(
        decide_claim(&suspended, &during, 160),
        ClaimDecision::Suspended
    );
    let lifted = lift(&suspended, 200);
    assert_eq!(lifted.last_lifted_at, Some(200));
    assert_eq!(
        decide_claim(&lifted, &during, 300),
        ClaimDecision::StaleChallenge
    );
    // Only a request made under the lift's generation counts.
    let after = ClaimAsk {
        requested_at: 201,
        generation: lifted.generation,
        ..during
    };
    assert_eq!(decide_claim(&lifted, &after, 300), ClaimDecision::Granted);
    // The timestamps only move forward, and are kept for the record.
    let (again, _) = suspend(&lifted, 50);
    assert_eq!(again.last_suspended_at, Some(100));
    let relifted = lift(&again, 120);
    assert_eq!(relifted.last_lifted_at, Some(200));
    let (later, _) = suspend(&lifted, 400);
    assert_eq!(later.last_suspended_at, Some(400));
}

#[test]
fn a_clock_running_backwards_never_revives_a_request() {
    // The review's case: lift at 200, a request at 201, then a suspension stamped 150 and a lift stamped 180.
    let (suspended, _) = suspend(&EMPTY, 100);
    let lifted = lift(&suspended, 200);
    let request = ClaimAsk {
        room: "ws_a",
        request: "hr_a",
        requested_at: 201,
        proof_matched: true,
        generation: lifted.generation,
    };
    assert_eq!(decide_claim(&lifted, &request, 202), ClaimDecision::Granted);
    let (again, _) = suspend(&lifted, 150);
    let relifted = lift(&again, 180);
    assert_eq!(
        decide_claim(&relifted, &request, 300),
        ClaimDecision::StaleChallenge
    );
    // Each suspend, lift and free advances the generation.
    assert_eq!(
        [
            suspended.generation,
            lifted.generation,
            again.generation,
            relifted.generation
        ],
        [1, 2, 3, 4]
    );
    assert_eq!(free(&relifted, 0).generation, 5);
    // A request under the newest generation is granted, whatever its clock says.
    let fresh = ClaimAsk {
        requested_at: 0,
        request: "hr_a2",
        generation: relifted.generation,
        ..request
    };
    assert_eq!(decide_claim(&relifted, &fresh, 300), ClaimDecision::Granted);
}

#[test]
fn code_points_idna_drops_are_refused_in_names_and_rules() {
    for c in [
        '\u{2060}',
        '\u{180E}',
        '\u{FE0F}',
        '\u{034F}',
        '\u{00AD}',
        '\u{200B}',
        '\u{FEFF}',
        '\u{1D173}',
    ] {
        let name = format!("app.exa{c}mple.com");
        assert_eq!(normalize(&name), Err(HostnameRefusal::Invalid), "{c:?}");
        let rule = format!("c{c}om");
        assert_eq!(
            mappable("app.example.com", CONTENT, &[&rule], false, 0),
            Err(HostnameRefusal::Unclassified),
            "{c:?}"
        );
    }
}

#[test]
fn a_byte_order_mark_is_stripped_and_any_other_unreadable_rule_fails_closed() {
    let list = "\u{FEFF}// ===BEGIN ICANN DOMAINS===\ncom\nco.uk\n";
    assert_eq!(public_suffix_rules(list), ["com", "co.uk"]);
    assert!(mappable(
        "app.example.com",
        CONTENT,
        &public_suffix_rules(list),
        false,
        0
    )
    .is_ok());
    // A whitespace-free rule that isn't hostname labels fails closed, and so does one hiding a character IDNA drops.
    for bad in [
        "#hash",
        "foo.com//x",
        "foo_bar.com",
        "a@b",
        "com\u{FEFF}",
        "\u{FEFF}com",
        "co\u{AD}m",
        "c\u{200B}om",
    ] {
        assert_eq!(
            mappable("app.example.com", CONTENT, &["com", bad], false, 0),
            Err(HostnameRefusal::Unclassified),
            "{bad:?}"
        );
    }
    // Upper case in a rule is still a rule.
    assert!(mappable("app.example.com", CONTENT, &["COM"], false, 0).is_ok());
}
