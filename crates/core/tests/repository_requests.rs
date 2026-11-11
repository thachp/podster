//! The caps on asking for a managed repository, and what an organization's delegation record means (M5, ADR 0009,
//! which is proposed; the owner's decision of 2026-11-11, "No gate, with limits").

use podster_core::provisioning::{
    organization_delegated, repository_request_allowed, RequestLimitReached,
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
