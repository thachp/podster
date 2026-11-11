//! The caps on asking for a managed repository, and what an organization's delegation record means (M5, ADR 0009,
//! which is proposed; the owner's decision of 2026-11-11, "No gate, with limits").

use podster_core::provisioning::{
    organization_delegated, repository_place_held, repository_request_allowed, RequestLimitReached,
    MAX_REPOSITORY_REQUESTS_PER_DAY, REPOSITORY_REQUEST_WINDOW_MS,
};

const NOW: i64 = 10 * REPOSITORY_REQUEST_WINDOW_MS;

#[test]
fn an_organization_holds_the_delegation_unless_it_was_explicitly_taken_back() {
    assert!(organization_delegated(None));
    assert!(organization_delegated(Some(true)));
    assert!(!organization_delegated(Some(false)));
}

#[test]
fn five_requests_are_accepted_in_a_rolling_day_and_the_sixth_is_refused_by_name() {
    assert_eq!(MAX_REPOSITORY_REQUESTS_PER_DAY, 5);
    assert_eq!(REPOSITORY_REQUEST_WINDOW_MS, 86_400_000);
    assert_eq!(RequestLimitReached.code(), "repository_request_limit");
    for accepted in 0..=7_i64 {
        let times: Vec<i64> = (0..accepted).map(|n| NOW - 1 - n).collect();
        assert_eq!(
            repository_request_allowed(&times, NOW),
            if accepted < 5 {
                Ok(())
            } else {
                Err(RequestLimitReached)
            },
            "{accepted}"
        );
    }
}

#[test]
fn only_requests_inside_the_window_count() {
    let edge = NOW - REPOSITORY_REQUEST_WINDOW_MS;
    // Exactly a day old has left the window, and one millisecond younger hasn't.
    assert_eq!(repository_request_allowed(&[edge; 5], NOW), Ok(()));
    assert_eq!(
        repository_request_allowed(&[edge + 1; 5], NOW),
        Err(RequestLimitReached)
    );
    // Four inside and any number outside leave room for one more.
    let mut times = vec![edge - 1; 50];
    times.extend([NOW - 1; 4]);
    assert_eq!(repository_request_allowed(&times, NOW), Ok(()));
    times.push(NOW);
    assert_eq!(
        repository_request_allowed(&times, NOW),
        Err(RequestLimitReached)
    );
    // A time ahead of the clock still counts: it never frees a place.
    assert_eq!(
        repository_request_allowed(&[NOW + 1_000; 5], NOW),
        Err(RequestLimitReached)
    );
}

/// A small generator with a fixed seed, so the cases below are the same every run.
fn next(state: &mut u64) -> u64 {
    *state = state
        .wrapping_mul(6_364_136_223_846_793_005)
        .wrapping_add(1_442_695_040_888_963_407);
    *state >> 33
}

/// The cap decision against its own definition, over many made-up histories: a new room takes a place exactly when
/// fewer than five other rooms were stamped inside the window, and a room that holds a place always keeps it.
#[test]
fn a_place_is_held_exactly_when_the_definition_says_over_many_histories() {
    let mut state = 0x5eed_u64;
    for case in 0..5_000 {
        let rooms = (next(&mut state) % 12) as usize;
        // Stamps from two days back to a minute ahead, clustered around the window's edge half the time.
        let stamps: Vec<i64> = (0..rooms)
            .map(|_| {
                if next(&mut state) % 2 == 0 {
                    NOW - REPOSITORY_REQUEST_WINDOW_MS + (next(&mut state) % 5) as i64 - 2
                } else {
                    NOW - (next(&mut state) % (2 * REPOSITORY_REQUEST_WINDOW_MS as u64)) as i64
                        + 60_000
                }
            })
            .collect();
        let inside = stamps
            .iter()
            .filter(|at| NOW - **at < REPOSITORY_REQUEST_WINDOW_MS)
            .count();
        assert_eq!(
            repository_request_allowed(&stamps, NOW).is_ok(),
            inside < 5,
            "case {case}: {stamps:?}"
        );
        assert_eq!(
            repository_place_held(false, &stamps, NOW),
            inside < 5,
            "case {case}: {stamps:?}"
        );
        assert!(repository_place_held(true, &stamps, NOW), "case {case}");
        // Order never matters, and adding a stamp never frees a place.
        let mut reversed = stamps.clone();
        reversed.reverse();
        assert_eq!(
            repository_place_held(false, &reversed, NOW),
            repository_place_held(false, &stamps, NOW),
            "case {case}"
        );
        let mut more = stamps.clone();
        more.push(NOW - (next(&mut state) % (2 * REPOSITORY_REQUEST_WINDOW_MS as u64)) as i64);
        assert!(
            !repository_place_held(false, &more, NOW) || repository_place_held(false, &stamps, NOW),
            "case {case}: a further stamp freed a place"
        );
    }
}

#[test]
fn a_room_that_holds_a_place_keeps_it_at_the_cap_and_a_new_room_is_refused_there() {
    let full = [NOW - 1; 5];
    assert!(repository_place_held(true, &full, NOW));
    assert!(!repository_place_held(false, &full, NOW));
    assert!(repository_place_held(false, &full[..4], NOW));
    assert!(repository_place_held(false, &[], NOW));
}
