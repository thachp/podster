#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]
//! Access to a preview host, the pure rules (M8 step 4; the preview plan's 5.3 to 5.5 and 5.8, with spike P1's results
//! of 2026-11-28): the claims of a ticket, a session and a marker token with their lifetimes, the checks a token must
//! pass, the two exact cookie names, the write rule, the loop guard, the return path, and the rate limits on
//! `/v1/preview-access`: 30 a minute for each person and 300 an hour for each room.

use podster_core::preview_access::*;
use podster_core::release_tree::MARKER_PATH;

const NOW: i64 = 1_800_000_000_000;
const HOST: &str = "pv7q2.podster.site";
const SLOT: &str = "pvw_0123456789abcdef0123456789abcdef";
const SID: &str = "pvs_fedcba9876543210fedcba9876543210";
const KID: &str = "k1";
/// The SHA-256 of an empty string, base64url without padding: a well-formed state hash.
const ST: &str = "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU";
const ST2: &str = "LPJNul-wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ";

fn next(state: &mut u64) -> u64 {
    *state = state
        .wrapping_mul(6_364_136_223_846_793_005)
        .wrapping_add(1_442_695_040_888_963_407);
    *state >> 33
}

fn ask() -> TokenAsk<'static> {
    TokenAsk {
        kid: KID,
        host: HOST,
        slot: SLOT,
        session: SID,
        epoch: 3,
        state_hash: ST,
        now: NOW,
    }
}

fn presented(now: i64) -> Presented<'static> {
    Presented {
        host: HOST,
        now,
        entry_slot: SLOT,
        entry_epoch: 3,
        state_hash: Some(ST),
        path: "/",
        method: "GET",
    }
}

// --- forms -------------------------------------------------------------------------------------------------------------

#[test]
fn the_three_token_types_are_named_and_carry_their_lifetimes() {
    assert_eq!(
        TokenType::ALL,
        [TokenType::Ticket, TokenType::Session, TokenType::Marker]
    );
    for typ in TokenType::ALL {
        assert_eq!(TokenType::parse(typ.name()), Some(typ));
    }
    assert_eq!(TokenType::Ticket.name(), "ticket");
    assert_eq!(TokenType::Session.name(), "session");
    assert_eq!(TokenType::Marker.name(), "marker");
    for other in ["", "Ticket", "SESSION", "marker ", "access"] {
        assert_eq!(TokenType::parse(other), None, "{other:?}");
    }
    assert_eq!(TICKET_TTL_MS, 60_000);
    assert_eq!(SESSION_MAX_TTL_MS, 3_600_000);
    assert_eq!(MARKER_TTL_MS, 60_000);
    assert_eq!(TokenType::Ticket.max_ttl_ms(), TICKET_TTL_MS);
    assert_eq!(TokenType::Session.max_ttl_ms(), SESSION_MAX_TTL_MS);
    assert_eq!(TokenType::Marker.max_ttl_ms(), MARKER_TTL_MS);
}

#[test]
fn a_state_hash_is_a_canonical_base64url_sha256() {
    assert!(is_state_hash(ST));
    assert!(is_state_hash(ST2));
    for bad in [
        "",
        "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuF",
        "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFUU",
        "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU",
        "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuF=",
        // The last character carries two bits past the 256; a 32-byte value leaves them zero.
        "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFV",
        "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuF ",
    ] {
        assert!(!is_state_hash(bad), "{bad:?}");
    }
}

#[test]
fn slot_session_and_key_ids_have_fixed_forms() {
    assert!(is_slot_id(SLOT));
    assert!(is_session_id(SID));
    assert!(!is_slot_id(SID));
    assert!(!is_session_id(SLOT));
    for bad in [
        "",
        "pvw_",
        "pvw_0123456789ABCDEF0123456789abcdef",
        "pvw_0123456789abcdef0123456789abcde",
    ] {
        assert!(!is_slot_id(bad), "{bad:?}");
    }
    assert!(is_key_id("k1"));
    assert!(is_key_id("2026-11_a"));
    assert!(!is_key_id(""));
    assert!(!is_key_id(&"k".repeat(65)));
    assert!(!is_key_id("k 1"));
    assert!(!is_key_id("k.1"));
}

// --- minting -----------------------------------------------------------------------------------------------------------

#[test]
fn a_ticket_lasts_sixty_seconds_and_carries_ids_and_hashes_only() {
    let claims = ticket_claims(&ask()).unwrap();
    assert_eq!(claims.typ, TokenType::Ticket);
    assert_eq!(claims.kid, KID);
    assert_eq!(claims.aud, HOST);
    assert_eq!(claims.pvw, SLOT);
    assert_eq!(claims.sid.as_deref(), Some(SID));
    assert_eq!(claims.ep, 3);
    assert_eq!(claims.iat, NOW);
    assert_eq!(claims.exp, NOW + 60_000);
    assert_eq!(claims.st.as_deref(), Some(ST));
}

#[test]
fn a_session_lasts_at_most_an_hour_and_is_bound_to_the_same_state() {
    let claims = session_claims(&ask()).unwrap();
    assert_eq!(claims.typ, TokenType::Session);
    assert_eq!(claims.exp, NOW + 3_600_000);
    assert_eq!(claims.st.as_deref(), Some(ST));
    assert_eq!(claims.sid.as_deref(), Some(SID));
}

#[test]
fn a_marker_token_is_bound_to_the_host_with_no_session_or_state() {
    let claims = marker_claims(KID, HOST, SLOT, 3, NOW).unwrap();
    assert_eq!(claims.typ, TokenType::Marker);
    assert_eq!(claims.exp, NOW + 60_000);
    assert_eq!(claims.sid, None);
    assert_eq!(claims.st, None);
}

#[test]
fn nothing_is_minted_from_a_malformed_part() {
    let a = ask();
    let refusals = [
        TokenAsk { kid: "", ..a },
        TokenAsk { host: "", ..a },
        TokenAsk {
            host: "PV7Q2.podster.site",
            ..a
        },
        TokenAsk {
            host: "pv7q2.podster.site.",
            ..a
        },
        TokenAsk {
            host: "https://pv7q2.podster.site",
            ..a
        },
        TokenAsk {
            host: "*.podster.site",
            ..a
        },
        TokenAsk {
            slot: "rel_0123456789abcdef0123456789abcdef",
            ..a
        },
        TokenAsk { session: SLOT, ..a },
        TokenAsk {
            state_hash: "x",
            ..a
        },
        TokenAsk {
            epoch: podster_core::preview::MAX_ACCESS_EPOCH + 1,
            ..a
        },
    ];
    for bad in refusals {
        assert_eq!(ticket_claims(&bad), Err(PreviewClaimRefusal), "{bad:?}");
        assert_eq!(session_claims(&bad), Err(PreviewClaimRefusal), "{bad:?}");
    }
    assert_eq!(PreviewClaimRefusal.code(), "preview_claims_invalid");
    assert_eq!(
        marker_claims("", HOST, SLOT, 0, NOW),
        Err(PreviewClaimRefusal)
    );
    assert_eq!(
        marker_claims(KID, "", SLOT, 0, NOW),
        Err(PreviewClaimRefusal)
    );
    assert_eq!(
        marker_claims(KID, HOST, SID, 0, NOW),
        Err(PreviewClaimRefusal)
    );
}

// --- checking ----------------------------------------------------------------------------------------------------------

#[test]
fn a_fresh_ticket_and_session_pass_on_their_own_host_with_their_own_state() {
    let ticket = ticket_claims(&ask()).unwrap();
    assert_eq!(
        check_claims(&ticket, TokenType::Ticket, &presented(NOW)),
        Ok(())
    );
    let session = session_claims(&ask()).unwrap();
    assert_eq!(
        check_claims(&session, TokenType::Session, &presented(NOW + 3_599_999)),
        Ok(())
    );
}

#[test]
fn a_token_fails_on_every_claim_that_isnt_this_requests() {
    let ticket = ticket_claims(&ask()).unwrap();
    let p = presented(NOW);
    let check = |claims: &Claims, typ, p: &Presented| check_claims(claims, typ, p);
    assert_eq!(
        check(&ticket, TokenType::Session, &p),
        Err(TokenRefusal::WrongType)
    );
    assert_eq!(
        check(&ticket, TokenType::Marker, &p),
        Err(TokenRefusal::WrongType)
    );
    assert_eq!(
        check(
            &ticket,
            TokenType::Ticket,
            &Presented {
                host: "other.podster.site",
                ..p
            }
        ),
        Err(TokenRefusal::WrongAudience)
    );
    assert_eq!(
        check(
            &ticket,
            TokenType::Ticket,
            &Presented {
                host: "PV7Q2.podster.site",
                ..p
            }
        ),
        Err(TokenRefusal::WrongAudience)
    );
    // Expired at exactly exp.
    assert_eq!(
        check(&ticket, TokenType::Ticket, &presented(NOW + 60_000)),
        Err(TokenRefusal::Expired)
    );
    assert_eq!(
        check(&ticket, TokenType::Ticket, &presented(NOW + 59_999)),
        Ok(())
    );
    // Below the epoch the host's entry holds.
    assert_eq!(
        check(
            &ticket,
            TokenType::Ticket,
            &Presented {
                entry_epoch: 4,
                ..p
            }
        ),
        Err(TokenRefusal::EpochBelow)
    );
    assert_eq!(
        check(
            &ticket,
            TokenType::Ticket,
            &Presented {
                entry_epoch: 2,
                ..p
            }
        ),
        Ok(())
    );
    // Another browser's state, or none.
    assert_eq!(
        check(
            &ticket,
            TokenType::Ticket,
            &Presented {
                state_hash: Some(ST2),
                ..p
            }
        ),
        Err(TokenRefusal::StateMismatch)
    );
    assert_eq!(
        check(
            &ticket,
            TokenType::Ticket,
            &Presented {
                state_hash: None,
                ..p
            }
        ),
        Err(TokenRefusal::StateMismatch)
    );
}

#[test]
fn a_token_that_claims_to_live_longer_than_its_type_may_is_refused() {
    let mut ticket = ticket_claims(&ask()).unwrap();
    ticket.exp = ticket.iat + TICKET_TTL_MS + 1;
    assert_eq!(
        check_claims(&ticket, TokenType::Ticket, &presented(NOW)),
        Err(TokenRefusal::Malformed)
    );
    let mut session = session_claims(&ask()).unwrap();
    session.exp = session.iat + SESSION_MAX_TTL_MS + 1;
    assert_eq!(
        check_claims(&session, TokenType::Session, &presented(NOW)),
        Err(TokenRefusal::Malformed)
    );
    let mut backwards = ticket_claims(&ask()).unwrap();
    backwards.exp = backwards.iat - 1;
    assert_eq!(
        check_claims(&backwards, TokenType::Ticket, &presented(NOW - 10)),
        Err(TokenRefusal::Malformed)
    );
}

#[test]
fn a_ticket_or_session_missing_its_session_or_state_is_malformed() {
    let mut ticket = ticket_claims(&ask()).unwrap();
    ticket.st = None;
    assert_eq!(
        check_claims(&ticket, TokenType::Ticket, &presented(NOW)),
        Err(TokenRefusal::Malformed)
    );
    let mut session = session_claims(&ask()).unwrap();
    session.sid = None;
    assert_eq!(
        check_claims(&session, TokenType::Session, &presented(NOW)),
        Err(TokenRefusal::Malformed)
    );
    // A marker carrying a state or a session is malformed too: it is no browser's.
    let mut marker = marker_claims(KID, HOST, SLOT, 3, NOW).unwrap();
    marker.sid = Some(SID.to_owned());
    let at_marker = Presented {
        path: "/.well-known/podster-release.json",
        state_hash: None,
        ..presented(NOW)
    };
    assert_eq!(
        check_claims(&marker, TokenType::Marker, &at_marker),
        Err(TokenRefusal::Malformed)
    );
}

#[test]
fn a_marker_token_opens_the_marker_path_with_get_and_nothing_else() {
    let marker = marker_claims(KID, HOST, SLOT, 3, NOW).unwrap();
    let path = format!("/{MARKER_PATH}");
    let at = |path: &'static str, method: &'static str| Presented {
        path,
        method,
        state_hash: None,
        ..presented(NOW)
    };
    let path: &'static str = Box::leak(path.into_boxed_str());
    assert_eq!(
        check_claims(&marker, TokenType::Marker, &at(path, "GET")),
        Ok(())
    );
    for method in ["HEAD", "POST", "PUT", "DELETE", "get", "OPTIONS"] {
        assert_eq!(
            check_claims(&marker, TokenType::Marker, &at(path, method)),
            Err(TokenRefusal::MarkerOnly),
            "{method}"
        );
    }
    for other in [
        "/",
        "/index.html",
        "/.well-known/podster-release.json/",
        "/.well-known/Podster-Release.json",
        "/.well-known/podster-release.json?x=1",
    ] {
        assert_eq!(
            check_claims(&marker, TokenType::Marker, &at(other, "GET")),
            Err(TokenRefusal::MarkerOnly),
            "{other}"
        );
    }
}

#[test]
fn every_refusal_has_a_code() {
    for refusal in TokenRefusal::ALL {
        assert!(!refusal.code().is_empty());
    }
    assert_eq!(TokenRefusal::Expired.code(), "preview_session_expired");
    assert_eq!(TokenRefusal::WrongType.code(), "preview_access_required");
}

/// Random claims, each one field off from a valid ticket: every single change is refused, and only the untouched
/// ticket passes.
#[test]
fn property_any_one_claim_changed_refuses_the_ticket() {
    let good = ticket_claims(&ask()).unwrap();
    let p = presented(NOW + 1);
    assert_eq!(check_claims(&good, TokenType::Ticket, &p), Ok(()));
    let mut seed = 0x5eed_ac55_u64;
    for _ in 0..5_000 {
        let mut bad = good.clone();
        match next(&mut seed) % 8 {
            0 => bad.typ = TokenType::ALL[(1 + next(&mut seed) % 2) as usize],
            1 => bad.aud = format!("x{}.podster.site", next(&mut seed)),
            2 => bad.ep = next(&mut seed) % 3,
            3 => bad.exp = NOW - (next(&mut seed) % 1_000) as i64,
            4 => bad.st = Some(ST2.to_owned()),
            5 => bad.st = None,
            6 => bad.exp = bad.iat + TICKET_TTL_MS + 1 + (next(&mut seed) % 1_000) as i64,
            _ => bad.pvw = format!("pvw_{:032x}", 1 + next(&mut seed)),
        }
        assert!(
            check_claims(&bad, TokenType::Ticket, &p).is_err(),
            "{bad:?}"
        );
    }
}

// --- the two cookies ---------------------------------------------------------------------------------------------------

#[test]
fn the_cookie_names_are_exactly_the_plans() {
    assert_eq!(SESSION_COOKIE, "__Host-podster_preview");
    assert_eq!(STATE_COOKIE, "__Host-podster_preview_state");
    assert_eq!(STATE_COOKIE_MAX_AGE_S, 12 * 60 * 60);
    assert_eq!(SESSION_COOKIE_MAX_AGE_S, 3_600);
}

#[test]
fn only_the_two_exact_names_are_read_and_case_variants_are_ignored() {
    let read = gate_cookies(&[
        ("__Host-podster_preview", "s"),
        ("__Host-podster_preview_state", "t"),
        ("other", "x"),
    ])
    .unwrap();
    assert_eq!(
        read,
        GateCookies {
            session: Some("s"),
            state: Some("t")
        }
    );
    // Spike P1, item 1: WebKit stores a sibling's case variant for the whole domain, so a case variant is ignored, never
    // refused, or one sibling would lock every WebKit viewer out of every other preview.
    let read = gate_cookies(&[
        ("__HOST-podster_preview", "evil"),
        ("__host-podster_preview", "evil"),
        ("__HoSt-podster_preview_state", "evil"),
        ("__Host-Podster_Preview", "evil"),
        ("podster_preview", "evil"),
        ("", "__Host-podster_preview=evil"),
        ("__Host-podster_preview ", "evil"),
    ])
    .unwrap();
    assert_eq!(
        read,
        GateCookies {
            session: None,
            state: None
        }
    );
}

#[test]
fn a_second_cookie_of_an_exact_name_refuses_the_request() {
    for name in [SESSION_COOKIE, STATE_COOKIE] {
        assert_eq!(
            gate_cookies(&[(name, "a"), ("x", "y"), (name, "b")]),
            Err(DuplicateCookie)
        );
        // Even with the same value: never pick one.
        assert_eq!(
            gate_cookies(&[(name, "a"), (name, "a")]),
            Err(DuplicateCookie)
        );
    }
    assert_eq!(DuplicateCookie.code(), "preview_access_required");
}

// --- the write rule ----------------------------------------------------------------------------------------------------

#[test]
fn reads_pass_and_writes_need_sec_fetch_site_same_origin() {
    for method in ["GET", "HEAD", "OPTIONS"] {
        assert!(write_allowed(method, None, None, HOST), "{method}");
        assert!(
            write_allowed(method, Some("cross-site"), None, HOST),
            "{method}"
        );
    }
    for method in ["POST", "PUT", "PATCH", "DELETE", "get", "Post", "PROPFIND"] {
        assert!(
            write_allowed(method, Some("same-origin"), None, HOST),
            "{method}"
        );
        // Spike P1, item 5: Firefox and WebKit send `Origin: null` on a page's own write; the header decides.
        assert!(
            write_allowed(method, Some("same-origin"), Some("null"), HOST),
            "{method}"
        );
        for site in [
            "same-site",
            "cross-site",
            "none",
            "Same-Origin",
            "same-origin ",
            "",
        ] {
            assert!(
                !write_allowed(method, Some(site), Some(&format!("https://{HOST}")), HOST),
                "{method} {site:?}"
            );
        }
    }
}

#[test]
fn a_write_with_no_sec_fetch_site_needs_the_hosts_own_origin() {
    assert!(write_allowed(
        "POST",
        None,
        Some("https://pv7q2.podster.site"),
        HOST
    ));
    for origin in [
        None,
        Some("null"),
        Some("http://pv7q2.podster.site"),
        Some("https://pv7q2.podster.site/"),
        Some("https://pv7q2.podster.site:443"),
        Some("https://other.podster.site"),
        Some("https://PV7Q2.podster.site"),
        Some(""),
    ] {
        assert!(!write_allowed("POST", None, origin, HOST), "{origin:?}");
    }
}

// --- the loop guard ----------------------------------------------------------------------------------------------------

#[test]
fn the_flow_stops_after_its_second_round_within_a_minute() {
    assert_eq!(LOOP_GUARD_ROUNDS, 2);
    assert_eq!(LOOP_GUARD_WINDOW_MS, 60_000);
    let first = next_round(None, NOW);
    assert_eq!(
        first,
        LoopDecision::Round(FlowRounds {
            count: 1,
            first_at: NOW
        })
    );
    let LoopDecision::Round(after_first) = first else {
        panic!()
    };
    let second = next_round(Some(after_first), NOW + 10_000);
    assert_eq!(
        second,
        LoopDecision::Round(FlowRounds {
            count: 2,
            first_at: NOW
        })
    );
    let LoopDecision::Round(after_second) = second else {
        panic!()
    };
    assert_eq!(
        next_round(Some(after_second), NOW + 20_000),
        LoopDecision::Stop
    );
    assert_eq!(
        next_round(Some(after_second), NOW + 59_999),
        LoopDecision::Stop
    );
    // A minute on, the count starts again.
    assert_eq!(
        next_round(Some(after_second), NOW + 60_000),
        LoopDecision::Round(FlowRounds {
            count: 1,
            first_at: NOW + 60_000
        })
    );
    // A first round stamped in the future, a clock step back, still counts.
    assert_eq!(
        next_round(
            Some(FlowRounds {
                count: 2,
                first_at: NOW + 5_000
            }),
            NOW
        ),
        LoopDecision::Stop
    );
    assert_eq!(LoopDecision::Stop.code(), "preview_access_required");
}

// --- the return path ---------------------------------------------------------------------------------------------------

#[test]
fn a_return_path_is_a_path_on_the_same_host() {
    for good in ["/", "/a", "/a/b?c=d", "/?x=%2F", "/a#frag"] {
        assert!(return_path_ok(good), "{good:?}");
    }
    for bad in [
        "",
        "a",
        "//evil.example",
        "/\\evil.example",
        "https://evil.example/",
        "/a\nb",
        "/a\rb",
        "/a\u{0}",
        " /a",
        "/a b",
        "\\/a",
    ] {
        assert!(!return_path_ok(bad), "{bad:?}");
    }
    assert!(return_path_ok(&format!("/{}", "a".repeat(2_047))));
    assert!(!return_path_ok(&format!("/{}", "a".repeat(2_048))));
}

// --- the rate limits ---------------------------------------------------------------------------------------------------

#[test]
fn a_person_may_ask_thirty_times_a_minute() {
    assert_eq!(PER_PERSON_PER_MINUTE, 30);
    let window = 60_000;
    let under: Vec<i64> = (0..29).map(|i| NOW - i * 1_000).collect();
    assert_eq!(person_access_allowed(&under, NOW), Ok(()));
    let full: Vec<i64> = (0..30).map(|i| NOW - i * 1_000).collect();
    assert_eq!(person_access_allowed(&full, NOW), Err(AccessLimit::Person));
    assert_eq!(AccessLimit::Person.code(), "preview_access_limit");
    // A stamp a full minute old has left the window.
    let mut aged = full.clone();
    aged[29] = NOW - window;
    assert_eq!(person_access_allowed(&aged, NOW), Ok(()));
    // Stamps in the future count, so a clock step backwards can't free the minute.
    let future: Vec<i64> = (0..30).map(|i| NOW + i).collect();
    assert_eq!(
        person_access_allowed(&future, NOW),
        Err(AccessLimit::Person)
    );
}

#[test]
fn a_room_may_be_asked_three_hundred_times_an_hour() {
    assert_eq!(PER_ROOM_PER_HOUR, 300);
    let under: Vec<i64> = (0..299).map(|i| NOW - i * 10_000).collect();
    assert_eq!(room_access_allowed(&under, NOW), Ok(()));
    let full: Vec<i64> = (0..300).map(|i| NOW - i * 10_000).collect();
    assert_eq!(room_access_allowed(&full, NOW), Err(AccessLimit::Room));
    assert_eq!(AccessLimit::Room.code(), "preview_access_limit");
    let mut aged = full.clone();
    aged[299] = NOW - 3_600_000;
    assert_eq!(room_access_allowed(&aged, NOW), Ok(()));
}

#[test]
fn a_refused_ask_says_when_one_more_will_fit() {
    let full: Vec<i64> = (0..30).map(|i| NOW - i * 1_000).collect();
    // The oldest in the window is NOW - 29 s; it leaves at NOW - 29 s + 60 s.
    assert_eq!(person_retry_after_ms(&full, NOW), Some(31_000));
    assert_eq!(person_retry_after_ms(&full[..29], NOW), None);
    let room: Vec<i64> = (0..300).map(|i| NOW - i).collect();
    assert_eq!(room_retry_after_ms(&room, NOW), Some(3_600_000 - 299));
}

/// Random stamps: the limit refuses exactly when the window already holds the figure, and the wait it names is the
/// first moment the count falls below it.
#[test]
fn property_the_limits_count_exactly_the_window() {
    let mut seed = 0x5eed_1137_u64;
    for _ in 0..3_000 {
        let n = (next(&mut seed) % 45) as usize;
        let stamps: Vec<i64> = (0..n)
            .map(|_| NOW - (next(&mut seed) % 90_000) as i64 + 5_000)
            .collect();
        let in_window = stamps.iter().filter(|&&s| s > NOW - 60_000).count();
        let allowed = person_access_allowed(&stamps, NOW).is_ok();
        assert_eq!(allowed, in_window < 30, "{in_window}");
        match person_retry_after_ms(&stamps, NOW) {
            None => assert!(allowed),
            Some(wait) => {
                assert!(!allowed);
                assert!(wait >= 1);
                assert!(person_access_allowed(&stamps, NOW + wait).is_ok());
                assert!(person_access_allowed(&stamps, NOW + wait - 1).is_err());
            }
        }
    }
}

// --- the slot binding (M8 step 4's security review) --------------------------------------------------------------------

const NEW_SLOT: &str = "pvw_11111111111111111111111111111111";

#[test]
fn a_token_is_honoured_only_on_a_host_whose_entry_names_its_own_slot() {
    let ticket = ticket_claims(&ask()).unwrap();
    let session = session_claims(&ask()).unwrap();
    let elsewhere = Presented {
        entry_slot: NEW_SLOT,
        ..presented(NOW)
    };
    assert_eq!(
        check_claims(&ticket, TokenType::Ticket, &elsewhere),
        Err(TokenRefusal::WrongSlot)
    );
    assert_eq!(
        check_claims(&session, TokenType::Session, &elsewhere),
        Err(TokenRefusal::WrongSlot)
    );
    let marker = marker_claims(KID, HOST, SLOT, 3, NOW).unwrap();
    let at_marker = Presented {
        path: "/.well-known/podster-release.json",
        state_hash: None,
        ..elsewhere
    };
    assert_eq!(
        check_claims(&marker, TokenType::Marker, &at_marker),
        Err(TokenRefusal::WrongSlot)
    );
    assert_eq!(TokenRefusal::WrongSlot.code(), "preview_access_required");
}

/// The review's case: a custom preview hostname is deleted with its slot and claimed again by a new slot of the same
/// room, whose access epoch starts lower. A session from the old slot, still inside its hour, on the same host, is
/// refused by the slot, whatever the epochs say.
#[test]
fn a_reclaimed_host_with_a_lower_epoch_refuses_the_old_slots_tokens() {
    let host = "preview.example.com";
    let old = TokenAsk {
        host,
        epoch: 9,
        ..ask()
    };
    let session = session_claims(&old).unwrap();
    let ticket = ticket_claims(&old).unwrap();
    // The new slot's entry on the same host: epoch 0, below the old token's 9, so the epoch alone would honour it.
    let reclaimed = Presented {
        host,
        entry_slot: NEW_SLOT,
        entry_epoch: 0,
        ..presented(NOW + 1_000)
    };
    assert!(podster_core::preview::epoch_honoured(
        session.ep,
        reclaimed.entry_epoch
    ));
    assert_eq!(
        check_claims(&session, TokenType::Session, &reclaimed),
        Err(TokenRefusal::WrongSlot)
    );
    assert_eq!(
        check_claims(&ticket, TokenType::Ticket, &reclaimed),
        Err(TokenRefusal::WrongSlot)
    );
    // The new slot's own session on that host passes.
    let fresh = session_claims(&TokenAsk {
        host,
        slot: NEW_SLOT,
        epoch: 0,
        ..ask()
    })
    .unwrap();
    assert_eq!(check_claims(&fresh, TokenType::Session, &reclaimed), Ok(()));
}

#[test]
fn a_lower_epoch_on_the_same_slot_is_still_refused() {
    let session = session_claims(&TokenAsk { epoch: 2, ..ask() }).unwrap();
    assert_eq!(
        check_claims(&session, TokenType::Session, &presented(NOW)),
        Err(TokenRefusal::EpochBelow)
    );
}

#[test]
fn a_host_entry_naming_no_slot_honours_nothing() {
    let ticket = ticket_claims(&ask()).unwrap();
    for bad in ["", "pvw_", "PVW_0123456789abcdef0123456789abcdef"] {
        let p = Presented {
            entry_slot: bad,
            ..presented(NOW)
        };
        assert_eq!(
            check_claims(&ticket, TokenType::Ticket, &p),
            Err(TokenRefusal::WrongSlot),
            "{bad:?}"
        );
    }
}

// --- the wire form (M8 step 7) -------------------------------------------------------------------------------------------

/// Decodes base64url with no padding, for checking what the encoder wrote.
fn unbase64url(text: &str) -> Vec<u8> {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let values: Vec<u32> = text
        .bytes()
        .map(|b| ALPHABET.iter().position(|a| *a == b).unwrap() as u32)
        .collect();
    let mut out = Vec::new();
    for chunk in values.chunks(4) {
        let mut n = 0u32;
        for (i, v) in chunk.iter().enumerate() {
            n |= v << (18 - 6 * i);
        }
        let bytes = [(n >> 16) as u8, (n >> 8) as u8, n as u8];
        out.extend_from_slice(&bytes[..chunk.len() - 1]);
    }
    out
}

#[test]
fn base64url_is_rfc_4648s_url_alphabet_with_no_padding() {
    assert_eq!(base64url(b""), "");
    assert_eq!(base64url(b"f"), "Zg");
    assert_eq!(base64url(b"fo"), "Zm8");
    assert_eq!(base64url(b"foo"), "Zm9v");
    assert_eq!(base64url(b"foob"), "Zm9vYg");
    assert_eq!(base64url(&[0xfb, 0xff, 0xfe]), "-__-");
    let mut seed = 7u64;
    for len in 0..70 {
        let bytes: Vec<u8> = (0..len).map(|_| next(&mut seed) as u8).collect();
        let text = base64url(&bytes);
        assert!(!text.contains('='));
        assert_eq!(unbase64url(&text), bytes, "{len} bytes");
    }
}

#[test]
fn a_tickets_payload_is_its_claims_in_a_fixed_order_with_times_in_milliseconds() {
    let claims = ticket_claims(&ask()).unwrap();
    let payload = token_payload(&claims).unwrap();
    let json = String::from_utf8(unbase64url(&payload)).unwrap();
    assert_eq!(
        json,
        format!(
            r#"{{"typ":"ticket","kid":"{KID}","aud":"{HOST}","pvw":"{SLOT}","sid":"{SID}","ep":3,"iat":{NOW},"exp":{},"st":"{ST}"}}"#,
            NOW + TICKET_TTL_MS
        )
    );
    let session = token_payload(&session_claims(&ask()).unwrap()).unwrap();
    let json = String::from_utf8(unbase64url(&session)).unwrap();
    assert!(json.starts_with(r#"{"typ":"session","#));
    assert!(json.contains(&format!(r#""exp":{}"#, NOW + SESSION_MAX_TTL_MS)));
}

#[test]
fn a_marker_tokens_payload_has_no_session_or_state() {
    let claims = marker_claims(KID, HOST, SLOT, 9, NOW).unwrap();
    let json = String::from_utf8(unbase64url(&token_payload(&claims).unwrap())).unwrap();
    assert_eq!(
        json,
        format!(
            r#"{{"typ":"marker","kid":"{KID}","aud":"{HOST}","pvw":"{SLOT}","ep":9,"iat":{NOW},"exp":{}}}"#,
            NOW + MARKER_TTL_MS
        )
    );
}

#[test]
fn claims_that_arent_their_form_are_never_given_a_payload() {
    let good = ticket_claims(&ask()).unwrap();
    let broken: Vec<(&str, Claims)> = vec![
        (
            "kid",
            Claims {
                kid: "k 1".into(),
                ..good.clone()
            },
        ),
        (
            "kid empty",
            Claims {
                kid: String::new(),
                ..good.clone()
            },
        ),
        (
            "aud upper",
            Claims {
                aud: "PV7Q2.podster.site".into(),
                ..good.clone()
            },
        ),
        (
            "aud quote",
            Claims {
                aud: "a\".podster.site".into(),
                ..good.clone()
            },
        ),
        (
            "pvw",
            Claims {
                pvw: "pvw_1".into(),
                ..good.clone()
            },
        ),
        (
            "sid",
            Claims {
                sid: Some("pvs_\"".into()),
                ..good.clone()
            },
        ),
        (
            "no sid",
            Claims {
                sid: None,
                ..good.clone()
            },
        ),
        (
            "st",
            Claims {
                st: Some("not a hash".into()),
                ..good.clone()
            },
        ),
        (
            "no st",
            Claims {
                st: None,
                ..good.clone()
            },
        ),
        (
            "ep",
            Claims {
                ep: u64::MAX,
                ..good.clone()
            },
        ),
        (
            "exp before iat",
            Claims {
                exp: good.iat,
                ..good.clone()
            },
        ),
        (
            "too long",
            Claims {
                exp: good.iat + TICKET_TTL_MS + 1,
                ..good.clone()
            },
        ),
        (
            "marker with sid",
            Claims {
                typ: TokenType::Marker,
                ..good.clone()
            },
        ),
    ];
    for (what, claims) in broken {
        assert_eq!(token_payload(&claims), None, "{what}");
    }
}

#[test]
fn the_signature_is_over_a_fixed_label_and_the_payload_and_the_token_joins_them_with_a_dot() {
    assert_eq!(TOKEN_SIGNING_PREFIX, "podster-preview-token/v1.");
    assert_eq!(signing_input("abc"), "podster-preview-token/v1.abc");
    assert_eq!(token("abc", &[0xfb, 0xff, 0xfe]), "abc.-__-");
}

#[test]
fn the_browser_is_sent_to_the_exchange_page_with_both_tokens_only_after_the_hash() {
    let at = enter_location(HOST, "p.s", "q.t", "/a/b?x=1&y=2#z").unwrap();
    assert_eq!(
        at,
        format!("https://{HOST}/__podster/enter#t=p.s&s=q.t&r=%2Fa%2Fb%3Fx%3D1%26y%3D2%23z")
    );
    let (before, _) = at.split_once('#').unwrap();
    assert!(!before.contains('?'), "nothing in a query");
    assert!(
        !before.contains("p.s") && !before.contains("q.t"),
        "nothing in the path"
    );
    assert_eq!(ENTER_PATH, "/__podster/enter");
    // `+`, `%` and spaces' stand-ins come back exactly under URLSearchParams.
    assert!(enter_location(HOST, "a", "b", "/%2B+")
        .unwrap()
        .ends_with("r=%2F%252B%2B"));
}

#[test]
fn the_exchange_location_refuses_a_host_or_return_path_not_of_its_form() {
    for host in [
        "",
        "PV.podster.site",
        "pv.podster.site.",
        "a b",
        "pv.podster.site/x",
        "https://pv.podster.site",
    ] {
        assert_eq!(enter_location(host, "a", "b", "/"), None, "{host:?}");
    }
    for r in ["", "x", "//evil.example", "/\\evil", "/a b", "/\n"] {
        assert_eq!(enter_location(HOST, "a", "b", r), None, "{r:?}");
    }
    for t in ["", "a#b", "a&b", "a=b", "a b"] {
        assert_eq!(enter_location(HOST, t, "b", "/"), None, "ticket {t:?}");
        assert_eq!(enter_location(HOST, "a", t, "/"), None, "session {t:?}");
    }
}
