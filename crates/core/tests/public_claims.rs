use podster_core::public_claims::*;

#[test]
fn the_room_checks_its_block_then_its_hour() {
    assert_eq!(check_room(false, 0), Ok(()));
    assert_eq!(check_room(false, 19), Ok(()));
    assert_eq!(check_room(false, 20), Err(PublicClaimLimit::RoomHourly));
    assert_eq!(check_room(true, 0), Err(PublicClaimLimit::OrgBlocked));
    assert_eq!(check_room(true, 50), Err(PublicClaimLimit::OrgBlocked));
}

#[test]
fn active_limits() {
    assert_eq!(check_agent_active(2), Ok(()));
    assert_eq!(check_agent_active(3), Err(PublicClaimLimit::AgentActive));
    assert_eq!(check_person_active(2), Ok(()));
    assert_eq!(check_person_active(3), Err(PublicClaimLimit::PersonActive));
}

#[test]
fn hourly_limits_agent_then_person_then_org() {
    let ok = HourlyCounts {
        agent: 4,
        person: 4,
        org: 19,
    };
    assert_eq!(check_hourly(ok), Ok(()));
    assert_eq!(
        check_hourly(HourlyCounts { agent: 5, ..ok }),
        Err(PublicClaimLimit::AgentHourly)
    );
    assert_eq!(
        check_hourly(HourlyCounts { person: 5, ..ok }),
        Err(PublicClaimLimit::PersonHourly)
    );
    assert_eq!(
        check_hourly(HourlyCounts { org: 20, ..ok }),
        Err(PublicClaimLimit::OrgHourly)
    );
    assert_eq!(
        check_hourly(HourlyCounts {
            agent: 9,
            person: 9,
            org: 99
        }),
        Err(PublicClaimLimit::AgentHourly)
    );
}

#[test]
fn the_values_match_decision_162() {
    assert_eq!(MAX_AGENT_ACTIVE_PUBLIC_CLAIMS, 3);
    assert_eq!(MAX_AGENT_PUBLIC_CLAIMS_PER_HOUR, 5);
    assert_eq!(MAX_PERSON_ACTIVE_PUBLIC_CLAIMS, 3);
    assert_eq!(MAX_PERSON_PUBLIC_CLAIMS_PER_HOUR, 5);
    assert_eq!(MAX_ORG_PUBLIC_CLAIMS_PER_HOUR, 20);
    assert_eq!(MAX_ROOM_PUBLIC_CLAIMS_PER_HOUR, 20);
}

#[test]
fn the_window_counts_the_last_hour() {
    let now = 10_000;
    assert_eq!(claims_in_window(&[], now), 0);
    assert_eq!(
        claims_in_window(&[now - 3_600, now - 3_599, now, now + 5], now),
        3
    );
}

#[test]
fn codes() {
    assert_eq!(PublicClaimLimit::OrgBlocked.code(), "not_allowed");
    assert_eq!(PublicClaimLimit::RoomHourly.code(), "limit_exceeded");
    assert_eq!(
        PublicClaimLimit::PersonActive.reason(),
        "public_claims.person_active"
    );
}
