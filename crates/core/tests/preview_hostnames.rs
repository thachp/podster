#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]
//! Custom hostname roles (M8 step 4; the preview plan's section 7, ADR 0010's revision on previews, item 8): each
//! claim is `production` or `preview`, a room holds at most one of each, one name is one claim whatever its role, and a
//! preview hostname needs a preview.

use podster_core::hostnames::*;

const P: &str = "app.example.com";
const Q: &str = "preview.example.com";

fn held(role: HostnameRole, hostname: &'static str) -> RoomHostname<'static> {
    RoomHostname { role, hostname }
}

#[test]
fn there_are_two_roles_and_no_row_is_production() {
    assert_eq!(
        HostnameRole::ALL,
        [HostnameRole::Production, HostnameRole::Preview]
    );
    for role in HostnameRole::ALL {
        assert_eq!(HostnameRole::parse(role.name()), Some(role));
    }
    assert_eq!(HostnameRole::Production.name(), "production");
    assert_eq!(HostnameRole::Preview.name(), "preview");
    assert_eq!(recorded_role(None), Some(HostnameRole::Production));
    assert_eq!(recorded_role(Some("preview")), Some(HostnameRole::Preview));
    for other in ["", "Preview", "staging", "preview "] {
        assert_eq!(recorded_role(Some(other)), None, "{other:?}");
        assert_eq!(HostnameRole::parse(other), None, "{other:?}");
    }
    assert_eq!(MAX_HOSTNAMES_PER_ROLE, 1);
}

#[test]
fn a_room_holds_one_hostname_of_each_role() {
    assert_eq!(
        role_request_allowed(&[], HostnameRole::Production, P, false),
        Ok(())
    );
    assert_eq!(
        role_request_allowed(&[], HostnameRole::Preview, Q, true),
        Ok(())
    );
    let production = [held(HostnameRole::Production, P)];
    assert_eq!(
        role_request_allowed(&production, HostnameRole::Preview, Q, true),
        Ok(())
    );
    assert_eq!(
        role_request_allowed(&production, HostnameRole::Production, Q, true),
        Err(RoleRefusal::RoomLimit)
    );
    let both = [
        held(HostnameRole::Production, P),
        held(HostnameRole::Preview, Q),
    ];
    assert_eq!(
        role_request_allowed(&both, HostnameRole::Preview, "other.example.com", true),
        Err(RoleRefusal::RoomLimit)
    );
    assert_eq!(RoleRefusal::RoomLimit.code(), "hostname_limit");
}

#[test]
fn one_name_cant_be_both_roles_in_one_room() {
    let production = [held(HostnameRole::Production, P)];
    assert_eq!(
        role_request_allowed(&production, HostnameRole::Preview, P, true),
        Err(RoleRefusal::Unavailable)
    );
    let preview = [held(HostnameRole::Preview, Q)];
    assert_eq!(
        role_request_allowed(&preview, HostnameRole::Production, Q, true),
        Err(RoleRefusal::Unavailable)
    );
    assert_eq!(RoleRefusal::Unavailable.code(), "hostname_unavailable");
}

#[test]
fn a_preview_hostname_needs_a_preview_and_a_production_one_doesnt() {
    assert_eq!(
        role_request_allowed(&[], HostnameRole::Preview, Q, false),
        Err(RoleRefusal::PreviewNone)
    );
    assert_eq!(RoleRefusal::PreviewNone.code(), "preview_none");
    assert_eq!(
        role_request_allowed(&[], HostnameRole::Production, P, false),
        Ok(())
    );
}

/// Across rooms the hostname's own object decides, and it holds no role: a claim is one name for one room's request,
/// so a name another room holds for production is refused to a preview request too, by the same decision.
#[test]
fn across_rooms_one_claim_holds_the_name_whatever_its_role() {
    let record = HostnameRecord {
        claim: Some(Claim {
            room: "ws_a",
            request: "req_production",
        }),
        ending: false,
        suspended: false,
        last_freed_at: None,
        last_suspended_at: None,
        last_lifted_at: None,
        generation: 0,
    };
    let ask = ClaimAsk {
        room: "ws_b",
        request: "req_preview",
        requested_at: 10,
        proof_matched: true,
        generation: 0,
    };
    assert_eq!(
        decide_claim(&record, &ask, 20),
        ClaimDecision::HeldElsewhere
    );
    // Even the same room under another request, a preview request beside its production one, is refused.
    let same_room = ClaimAsk {
        room: "ws_a",
        ..ask
    };
    assert_eq!(
        decide_claim(&record, &same_room, 20),
        ClaimDecision::HeldElsewhere
    );
}

/// Every combination of what a room holds (nothing, or one name of either role, or one of each) and what it asks:
/// granted exactly when the role is free, the name is in no role here, and a preview has its slot.
#[test]
fn exhaustively_a_role_request_is_allowed_exactly_when_its_role_and_name_are_free() {
    let names = [P, Q, "third.example.com"];
    let mut holdings: Vec<Vec<RoomHostname>> = vec![vec![]];
    for role in HostnameRole::ALL {
        for name in names {
            holdings.push(vec![held(role, name)]);
        }
    }
    for p in names {
        for q in names {
            if p != q {
                holdings.push(vec![
                    held(HostnameRole::Production, p),
                    held(HostnameRole::Preview, q),
                ]);
            }
        }
    }
    for holding in &holdings {
        for role in HostnameRole::ALL {
            for name in names {
                for slot in [false, true] {
                    let result = role_request_allowed(holding, role, name, slot);
                    let expected = if role == HostnameRole::Preview && !slot {
                        Err(RoleRefusal::PreviewNone)
                    } else if holding.iter().any(|h| h.hostname == name && h.role != role) {
                        Err(RoleRefusal::Unavailable)
                    } else if holding.iter().filter(|h| h.role == role).count()
                        >= MAX_HOSTNAMES_PER_ROLE
                    {
                        Err(RoleRefusal::RoomLimit)
                    } else {
                        Ok(())
                    };
                    assert_eq!(result, expected, "{holding:?} {role:?} {name} {slot}");
                }
            }
        }
    }
}
