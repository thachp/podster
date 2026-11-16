//! M6 step 8b: the custom hostname at Cloudflare, created only for a committed claim, and the long end of a claim (ADR
//! 0010, "Custom domains", steps 5, 6 and 8). The object marks a claim ending and frees it only once the room says the
//! custom hostname is gone; the room's job decides each step from its own row and from what Cloudflare's read showed,
//! and an answer it couldn't read settles nothing.

use podster_core::hostname_requests::*;
use podster_core::hostnames::*;

const NOW: i64 = 1_000 * 24 * 60 * 60 * 1000;

fn held<'a>(room: &'a str, request: &'a str, ending: bool) -> HostnameRecord<'a> {
    HostnameRecord {
        claim: Some(Claim { room, request }),
        ending,
        suspended: false,
        last_freed_at: None,
        last_suspended_at: None,
        last_lifted_at: None,
        generation: 4,
    }
}

const EMPTY: HostnameRecord = HostnameRecord {
    claim: None,
    ending: false,
    suspended: false,
    last_freed_at: None,
    last_suspended_at: None,
    last_lifted_at: None,
    generation: 4,
};

#[test]
fn the_object_marks_only_the_rooms_own_claim_ending_and_marking_again_changes_nothing() {
    let (after, begun) = begin_end(&held("ws_a", "hnr_1", false), "ws_a", "hnr_1");
    assert_eq!(begun, EndBegun::Ending);
    assert!(after.ending);
    assert_eq!(
        after.claim,
        Some(Claim {
            room: "ws_a",
            request: "hnr_1"
        })
    );
    // The generation moves only when the claim is freed.
    assert_eq!(after.generation, 4);
    let (again, begun) = begin_end(&after, "ws_a", "hnr_1");
    assert_eq!((again, begun), (after, EndBegun::Ending));
    // Another room's claim, or another request of this room, is untouched.
    for (room, request) in [("ws_b", "hnr_1"), ("ws_a", "hnr_2")] {
        let record = held("ws_a", "hnr_1", false);
        assert_eq!(
            begin_end(&record, room, request),
            (record, EndBegun::NotHeld)
        );
    }
    assert_eq!(
        begin_end(&EMPTY, "ws_a", "hnr_1"),
        (EMPTY, EndBegun::NotHeld)
    );
}

#[test]
fn the_object_frees_only_the_rooms_own_claim_and_only_once_it_is_ending() {
    // Live: never freed straight from live, so nothing frees a claim the object didn't first see ending.
    let live = held("ws_a", "hnr_1", false);
    assert_eq!(
        free_ended(&live, "ws_a", "hnr_1", NOW),
        (live, FreeOutcome::NotEnding)
    );
    let ending = held("ws_a", "hnr_1", true);
    let (after, outcome) = free_ended(&ending, "ws_a", "hnr_1", NOW);
    assert_eq!(outcome, FreeOutcome::Freed);
    assert_eq!(after.claim, None);
    assert!(!after.ending);
    assert_eq!(after.last_freed_at, Some(NOW));
    // Every free advances the generation, so no request made before it can claim after.
    assert_eq!(after.generation, 5);
    // Freed already, or someone else's: nothing of the record changes.
    assert_eq!(
        free_ended(&after, "ws_a", "hnr_1", NOW + 1),
        (after, FreeOutcome::NotHeld)
    );
    for (room, request) in [("ws_b", "hnr_1"), ("ws_a", "hnr_2")] {
        assert_eq!(
            free_ended(&ending, room, request, NOW),
            (ending, FreeOutcome::NotHeld)
        );
    }
    // A suspension outlives the claim it ended.
    let suspended = HostnameRecord {
        suspended: true,
        ..ending
    };
    let (after, outcome) = free_ended(&suspended, "ws_a", "hnr_1", NOW);
    assert_eq!(outcome, FreeOutcome::Freed);
    assert!(after.suspended);
}

#[test]
fn a_claim_whose_custom_hostname_vanished_at_cloudflare_ends_by_its_own_code() {
    assert_eq!(ClaimEnd::GoneAtProvider.code(), "hostname_gone_at_provider");
    assert_eq!(ClaimEnd::Moved.code(), "hostname_moved");
}

#[test]
fn a_committed_claim_is_created_once_and_read_after() {
    assert_eq!(claimed_step(false), ClaimedStep::Create);
    assert_eq!(claimed_step(true), ClaimedStep::Read);
}

#[test]
fn what_a_read_of_a_committed_claims_hostname_does() {
    // An answer that couldn't be read settles nothing: never "gone", never "there".
    for id in [false, true] {
        assert_eq!(
            after_claimed_read(ProviderRead::Unknown, id),
            AfterClaimedRead::Wait
        );
        assert_eq!(
            after_claimed_read(ProviderRead::Present { moved: false }, id),
            AfterClaimedRead::Keep
        );
        // Cloudflare's `moved` ends the claim; Podster doesn't wait for its own deletion after seven days.
        assert_eq!(
            after_claimed_read(ProviderRead::Present { moved: true }, id),
            AfterClaimedRead::End(ClaimEnd::Moved)
        );
    }
    // Read as gone after its ID was recorded: it was made and is no more, so the claim ends.
    assert_eq!(
        after_claimed_read(ProviderRead::Gone, true),
        AfterClaimedRead::End(ClaimEnd::GoneAtProvider)
    );
    // Read as gone with no ID ever recorded: the create's answer was lost and the read says nothing was made.
    assert_eq!(
        after_claimed_read(ProviderRead::Gone, false),
        AfterClaimedRead::CreateAgain
    );
}

#[test]
fn the_long_end_marks_the_object_then_deletes_and_reads_until_gone_then_frees() {
    // The object is told first, whatever else is so.
    for (create_sent, gone) in [(false, false), (true, false), (true, true)] {
        assert_eq!(end_step(false, create_sent, gone), EndStep::MarkEnding);
    }
    // Something was asked of Cloudflare: read until it reports the hostname gone.
    assert_eq!(end_step(true, true, false), EndStep::Read);
    assert_eq!(end_step(true, true, true), EndStep::Free);
    // Nothing was ever asked of Cloudflare, which the room records before it asks: there is nothing to delete.
    assert_eq!(end_step(true, false, false), EndStep::Free);
}

#[test]
fn a_read_during_the_long_end_deletes_what_is_there_and_only_a_read_says_gone() {
    assert_eq!(after_end_read(ProviderRead::Unknown), AfterEndRead::Wait);
    assert_eq!(
        after_end_read(ProviderRead::Present { moved: false }),
        AfterEndRead::Delete
    );
    assert_eq!(
        after_end_read(ProviderRead::Present { moved: true }),
        AfterEndRead::Delete
    );
    assert_eq!(after_end_read(ProviderRead::Gone), AfterEndRead::Gone);
}

#[test]
fn a_claim_ends_once_the_room_has_unpublished_since_its_request_was_made() {
    assert!(!unpublished_since(Some(3), Some(3)));
    assert!(unpublished_since(Some(3), Some(4)));
    // Either side unknown fails closed.
    assert!(unpublished_since(None, Some(3)));
    assert!(unpublished_since(Some(3), None));
    // The room's epoch never goes down; if it ever read lower, that is a fault, and it ends too.
    assert!(unpublished_since(Some(4), Some(3)));
}

#[test]
fn only_an_id_and_a_status_of_the_expected_form_are_kept() {
    assert!(provider_id_form("24c8c68e-bec2-49b6-868e-f06373780630"));
    for id in [
        "",
        "24C8C68E-bec2-49b6-868e-f06373780630",
        "24c8c68e-bec2-49b6-868e-f0637378063",
        "24c8c68e-bec2-49b6-868e-f06373780630x",
        "24c8c68ebbec2b49b6b868ebf06373780630",
        "24c8c68e-bec2-49b6-868e-f0637378063g",
        "../../accounts",
    ] {
        assert!(!provider_id_form(id), "{id}");
    }
    for status in [
        "active",
        "pending",
        "moved",
        "pending_deletion",
        "active_redeploying",
    ] {
        assert!(provider_status_form(status), "{status}");
    }
    for status in ["", "Active", "act ive", "a-b", &"a".repeat(33)] {
        assert!(!provider_status_form(status), "{status}");
    }
}

const MIN: i64 = 60 * 1000;

#[test]
fn gone_counts_only_after_two_reads_ten_minutes_apart_after_the_create_and_the_last_delete() {
    assert_eq!(GONE_SPAN_MS, 10 * MIN);
    let sent = NOW;
    // Too soon after the create: a create that may still land, or a list that lags, proves nothing.
    assert_eq!(
        count_gone(sent, None, None, sent + 10 * MIN - 1),
        GoneCount::NotYet
    );
    // The first read that counts is only noted.
    assert_eq!(
        count_gone(sent, None, None, sent + 10 * MIN),
        GoneCount::First
    );
    let first = sent + 10 * MIN;
    // A second too soon after it is nothing, and the first stays noted; one ten minutes after it confirms.
    assert_eq!(
        count_gone(sent, None, Some(first), first + 10 * MIN - 1),
        GoneCount::NotYet
    );
    assert_eq!(
        count_gone(sent, None, Some(first), first + 10 * MIN),
        GoneCount::Confirmed
    );
    // A delete since restarts the wait, and a first read noted before it doesn't count.
    let deleted = first + 5 * MIN;
    assert_eq!(
        count_gone(sent, Some(deleted), Some(first), deleted + 10 * MIN - 1),
        GoneCount::NotYet
    );
    assert_eq!(
        count_gone(sent, Some(deleted), Some(first), deleted + 10 * MIN),
        GoneCount::First
    );
    assert_eq!(
        count_gone(
            sent,
            Some(deleted),
            Some(deleted + 10 * MIN),
            deleted + 20 * MIN
        ),
        GoneCount::Confirmed
    );
    // A first read noted before the create, which would be a fault, never counts.
    assert_eq!(
        count_gone(sent, None, Some(sent - 1), sent + 30 * MIN),
        GoneCount::First
    );
}
