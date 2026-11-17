//! M6 step 8c: routing a custom hostname (ADR 0010, "Custom domains", step 5). A custom host's entry is written only
//! while the room holds its committed claim, Cloudflare's last read said `active`, the room hasn't unpublished since the
//! request and its own facts hold (the deep review's D6), and the hostname's object holds exactly that room's and
//! request's claim, live. What was read and fails refuses; what couldn't be read waits. The entry names the host it is
//! for, so a value under any other key is never served.

use podster_core::hostname_requests::*;
use podster_core::hostnames::*;

const SCRIPT: &str = "k3v9q2.rel_0123456789abcdef0123456789abcdef";
const HOUR: i64 = 60 * 60 * 1000;

fn local<'a>() -> RouteLocal<'a> {
    RouteLocal {
        claims_open: true,
        request_claimed: true,
        unpublished: false,
        room: RoomRead::Holds,
        cloudflare_status: Some("active"),
    }
}

fn record<'a>(room: &'a str, request: &'a str) -> HostnameRecord<'a> {
    HostnameRecord {
        claim: Some(Claim { room, request }),
        ending: false,
        suspended: false,
        last_freed_at: None,
        last_suspended_at: None,
        last_lifted_at: None,
        generation: 3,
    }
}

#[test]
fn every_local_fact_must_hold_and_one_read_and_failing_refuses_by_its_code() {
    assert_eq!(route_local(&local()), CustomRoute::Serve);
    let cases: [(RouteLocal, &str); 6] = [
        (
            RouteLocal {
                claims_open: false,
                ..local()
            },
            "hostname_claims_incomplete",
        ),
        (
            RouteLocal {
                request_claimed: false,
                ..local()
            },
            "hostname_not_claimed",
        ),
        (
            RouteLocal {
                unpublished: true,
                ..local()
            },
            "hostname_unpublished",
        ),
        (
            RouteLocal {
                room: RoomRead::Fails("workspace_archived"),
                ..local()
            },
            "workspace_archived",
        ),
        (
            RouteLocal {
                cloudflare_status: Some("pending"),
                ..local()
            },
            "hostname_not_active",
        ),
        (
            RouteLocal {
                cloudflare_status: None,
                ..local()
            },
            "hostname_not_active",
        ),
    ];
    for (check, code) in cases {
        assert_eq!(route_local(&check), CustomRoute::Refuse(code), "{code}");
    }
    // Cloudflare's status is matched exactly: nothing but `active` routes.
    for status in ["Active", "active ", "moved", "", "pending_validation"] {
        let check = RouteLocal {
            cloudflare_status: Some(status),
            ..local()
        };
        assert_eq!(
            route_local(&check),
            CustomRoute::Refuse("hostname_not_active")
        );
    }
}

#[test]
fn a_room_fact_that_couldnt_be_read_waits_but_never_outranks_a_refusal() {
    let unread = RouteLocal {
        room: RoomRead::Unread,
        ..local()
    };
    assert_eq!(route_local(&unread), CustomRoute::Wait("standing_unknown"));
    // A fact read and failing decides even while another couldn't be read.
    for check in [
        RouteLocal {
            claims_open: false,
            ..unread
        },
        RouteLocal {
            request_claimed: false,
            ..unread
        },
        RouteLocal {
            unpublished: true,
            ..unread
        },
        RouteLocal {
            cloudflare_status: Some("pending"),
            ..unread
        },
    ] {
        assert!(matches!(route_local(&check), CustomRoute::Refuse(_)));
    }
}

#[test]
fn the_object_must_hold_exactly_this_rooms_and_requests_claim_live_and_unsuspended() {
    let held = record("ws_a", "hnr_1");
    assert_eq!(
        route_claim(Some(&held), "ws_a", "hnr_1"),
        CustomRoute::Serve
    );
    // An object that couldn't be read is undecided: nothing new is written.
    assert_eq!(
        route_claim(None, "ws_a", "hnr_1"),
        CustomRoute::Wait("standing_unknown")
    );
    let refused = CustomRoute::Refuse("claim_not_live");
    assert_eq!(route_claim(Some(&held), "ws_b", "hnr_1"), refused);
    // The same room under another request is not this claim: a later request never serves on an earlier one's.
    assert_eq!(route_claim(Some(&held), "ws_a", "hnr_2"), refused);
    assert_eq!(
        route_claim(
            Some(&HostnameRecord {
                ending: true,
                ..held
            }),
            "ws_a",
            "hnr_1"
        ),
        refused
    );
    assert_eq!(
        route_claim(
            Some(&HostnameRecord {
                suspended: true,
                ..held
            }),
            "ws_a",
            "hnr_1"
        ),
        refused
    );
    assert_eq!(
        route_claim(
            Some(&HostnameRecord {
                claim: None,
                ..held
            }),
            "ws_a",
            "hnr_1"
        ),
        refused
    );
}

#[test]
fn a_custom_hosts_entry_names_its_own_host_and_only_reads_back_for_it() {
    let value = custom_entry_value("app.example.com", SCRIPT);
    assert_eq!(
        value.as_deref(),
        Some("k3v9q2.rel_0123456789abcdef0123456789abcdef@app.example.com")
    );
    let value = value.unwrap_or_default();
    assert_eq!(custom_entry_script("app.example.com", &value), Some(SCRIPT));
    // Under any other key it is nothing: a value copied, or written to the wrong key, is never served.
    assert_eq!(custom_entry_script("www.example.com", &value), None);
    assert_eq!(custom_entry_script("example.com", &value), None);
    // A default host's form, the script's name alone, is never a custom host's entry.
    assert_eq!(custom_entry_script("app.example.com", SCRIPT), None);
    // Only a script's name Podster makes, and only a host written as Podster writes names.
    assert_eq!(
        custom_entry_value("app.example.com", "someone-elses-script"),
        None
    );
    assert_eq!(custom_entry_value("App.Example.com", SCRIPT), None);
    assert_eq!(custom_entry_value("app.example.com.", SCRIPT), None);
    assert_eq!(custom_entry_value("*.example.com", SCRIPT), None);
    for bad in [
        "",
        "@app.example.com",
        "k3v9q2.rel_0123456789abcdef0123456789abcdef@",
        "k3v9q2.rel_0123456789abcdef0123456789abcdef@app.example.com ",
        "k3v9q2.rel_0123456789abcdef0123456789abcdef@@app.example.com",
        "k3v9q2.rel_0123456789abcdef0123456789abcdef@app.example.com@app.example.com",
        "K3v9q2.rel_0123456789abcdef0123456789abcdef@app.example.com",
        "k3v9q2.rel_0123456789abcdef0123456789abcdef@APP.example.com",
    ] {
        assert_eq!(custom_entry_script("app.example.com", bad), None, "{bad:?}");
    }
}

#[test]
fn a_routed_active_hostname_is_read_at_most_every_six_hours_and_any_other_as_before() {
    // D5, from the deep review of PR #403: once routing gives the read a purpose, its wakes are capped.
    let since = 1_000_000;
    for last_try in [since, since + 60_000, since + 5 * HOUR, since + 30 * HOUR] {
        assert_eq!(
            claimed_read_wait_ms(since, last_try, false),
            retry_wait_ms(since, last_try)
        );
        assert_eq!(claimed_read_wait_ms(since, last_try, true), ROUTED_READ_MS);
    }
    assert_eq!(ROUTED_READ_MS, 6 * HOUR);
    const { assert!(ROUTED_READ_MS >= RETRY_MAX_MS) };
}

mod waiting_entry {
    use podster_core::release::{
        commit_live, confirm_served, rollback, waiting_entry_keeps, DesiredServe, ReleaseState,
        ServeState,
    };

    const PREV: &str = "rel_6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d";
    const NEXT: &str = "rel_7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e";
    const ROLL: &str = "rel_4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b";
    const OLD: &str = "rel_3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a";

    fn script(release: &str) -> String {
        format!("app.{release}")
    }

    /// A room serving `PREV` on its default host and on a custom host, with `OLD` kept for a rollback.
    fn serving() -> ServeState {
        let host = |version| DesiredServe {
            script: Some(script(PREV)),
            version,
            closed: false,
        };
        ServeState {
            epoch: 2,
            hosts: vec![host(5), host(2)],
            kept_previous: Some(script(OLD)),
            in_flight: None,
        }
    }

    #[test]
    fn an_ordinary_commit_keeps_the_release_last_served_while_its_marker_is_out() {
        let Ok((during, _)) =
            commit_live(&serving(), 2, &script(NEXT), NEXT, ReleaseState::Uploading)
        else {
            unreachable!("the commit should go live");
        };
        let wanted = script(NEXT);
        assert!(waiting_entry_keeps(&during, &wanted, &script(PREV), false));
        // What it wants is kept too, and anything else comes down.
        assert!(waiting_entry_keeps(&during, &wanted, &wanted, false));
        assert!(!waiting_entry_keeps(&during, &wanted, &script(OLD), false));
    }

    #[test]
    fn a_rollback_uploaded_again_takes_down_the_release_it_rolls_away_from_too() {
        // A rollback that couldn't switch is committed under its own script, as a commit is: only its record says it
        // is a rollback, and that alone decides.
        let Ok((during, _)) =
            commit_live(&serving(), 2, &script(ROLL), ROLL, ReleaseState::Uploading)
        else {
            unreachable!("the re-upload should go live");
        };
        let wanted = script(ROLL);
        assert!(!waiting_entry_keeps(&during, &wanted, &script(PREV), true));
        assert!(waiting_entry_keeps(&during, &wanted, &wanted, true));
        // The same flight as an ordinary commit's keeps the release last served.
        assert!(waiting_entry_keeps(&during, &wanted, &script(PREV), false));
    }

    #[test]
    fn a_rollback_takes_down_the_release_it_rolls_away_from() {
        let Ok((during, _)) = rollback(&serving(), 2, true, ROLL, ReleaseState::Uploading) else {
            unreachable!("the rollback should go live");
        };
        let wanted = script(OLD);
        // The flight's own record is the rollback's, so the release being rolled away from isn't kept.
        assert_eq!(
            during.in_flight.as_ref().map(|f| f.release_id.as_str()),
            Some(ROLL)
        );
        assert!(!waiting_entry_keeps(&during, &wanted, &script(PREV), true));
        assert!(waiting_entry_keeps(&during, &wanted, &wanted, true));
        // Even if the room's rows failed to say it was a rollback, the script naming another release says so.
        assert!(!waiting_entry_keeps(&during, &wanted, &script(PREV), false));
    }

    #[test]
    fn once_the_marker_confirms_nothing_but_the_new_release_is_kept() {
        let Ok((during, mark)) =
            commit_live(&serving(), 2, &script(NEXT), NEXT, ReleaseState::Uploading)
        else {
            unreachable!("the commit should go live");
        };
        let Ok(after) = confirm_served(&during, &mark, &script(NEXT)) else {
            unreachable!("the marker should confirm");
        };
        // No flight: a host waiting for anything keeps only what it wants, which the applier then writes.
        assert!(!waiting_entry_keeps(
            &after.state,
            &script(NEXT),
            &script(PREV),
            false
        ));
        assert!(waiting_entry_keeps(
            &after.state,
            &script(NEXT),
            &script(NEXT),
            false
        ));
        // And with no flight at all, a wanted release that isn't served keeps nothing else.
        assert!(!waiting_entry_keeps(
            &serving(),
            &script(NEXT),
            &script(PREV),
            false
        ));
    }
}
