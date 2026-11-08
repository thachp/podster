#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

//! M3 step 12: whether an offer attempt may be sent, and the text it carries.

use podster_core::a2a::*;
use podster_core::{decide, decide_create, Command, NewTask, Observed, Task};
use AttemptState::*;

const AGENT: &str = "agt_remote";
const OFFER: &str = "evt_offer";

fn offered() -> Task {
    decide_create(
        "req",
        NewTask {
            id: "tsk_1".into(),
            title: "Write it".into(),
            instructions: "Write the report.".into(),
            acceptance_criteria: None,
            assignee: Some(AGENT.into()),
            reviewer: Some("rev".into()),
            due_at: None,
            follow_up_of: None,
            has_linked_repository: false,
        },
    )
    .unwrap()
    .task
}

fn step(task: &Task, actor: &str, command: Command) -> Task {
    decide(task, actor, command, &Observed::default())
        .unwrap()
        .task
}

#[test]
fn an_offered_task_on_the_attempts_offer_sends() {
    assert_eq!(
        may_send(&offered(), Some(OFFER), AGENT, OFFER, Queued, false),
        Ok(())
    );
}

#[test]
fn a_redelivered_or_ended_attempt_sends_nothing() {
    let task = offered();
    assert_eq!(
        may_send(&task, Some(OFFER), AGENT, OFFER, Sent, false),
        Err(NoSend::AlreadySent)
    );
    assert_eq!(
        may_send(&task, Some(OFFER), AGENT, OFFER, Stopped, false),
        Err(NoSend::Ended)
    );
    assert_eq!(
        may_send(&task, Some(OFFER), AGENT, OFFER, Queued, true),
        Err(NoSend::Busy)
    );
}

#[test]
fn a_task_that_moved_on_while_queued_sends_nothing() {
    let task = offered();
    let accepted = step(
        &task,
        AGENT,
        Command::Accept {
            version: task.version,
        },
    );
    assert_eq!(
        may_send(&accepted, Some(OFFER), AGENT, OFFER, Queued, false),
        Err(NoSend::OfferMovedOn)
    );
    let declined = step(
        &task,
        AGENT,
        Command::Decline {
            version: task.version,
            reason: "no".into(),
        },
    );
    assert_eq!(
        may_send(&declined, Some(OFFER), AGENT, OFFER, Queued, false),
        Err(NoSend::OfferMovedOn)
    );
    let canceled = step(
        &task,
        "req",
        Command::Cancel {
            version: task.version,
            reason: "done".into(),
        },
    );
    assert_eq!(
        may_send(&canceled, Some(OFFER), AGENT, OFFER, Queued, false),
        Err(NoSend::OfferMovedOn)
    );
    // Re-offered: a newer offer, even to the same agent, isn't this attempt's.
    assert_eq!(
        may_send(&task, Some("evt_newer"), AGENT, OFFER, Queued, false),
        Err(NoSend::OfferMovedOn)
    );
    assert_eq!(
        may_send(&task, None, AGENT, OFFER, Queued, false),
        Err(NoSend::OfferMovedOn)
    );
    // Reassigned to someone else.
    let other = step(
        &task,
        "req",
        Command::Assign {
            version: task.version,
            assignee: "agt_other".into(),
        },
    );
    assert_eq!(
        may_send(&other, Some(OFFER), AGENT, OFFER, Queued, false),
        Err(NoSend::OfferMovedOn)
    );
    // The offer moving on wins over a lease, so a stuck lease can't keep a moved-on attempt open.
    assert_eq!(
        may_send(&accepted, Some(OFFER), AGENT, OFFER, Queued, true),
        Err(NoSend::OfferMovedOn)
    );
}

#[test]
fn attempt_states_round_trip_by_name() {
    for state in [Queued, Sent, Stopped] {
        assert_eq!(AttemptState::from_name(state.name()), Some(state));
    }
    assert_eq!(AttemptState::from_name("SENT"), None);
}

#[test]
fn the_offer_text_has_the_task_and_the_link() {
    let text = offer_text(
        "Write it",
        "Write the report.",
        Some("Two pages."),
        Some("https://app.example/w/ws_1/tasks"),
    );
    assert_eq!(text, "# Write it\n\nWrite the report.\n\n## Acceptance criteria\n\nTwo pages.\n\nOn Podster: https://app.example/w/ws_1/tasks");
    assert_eq!(offer_text("T", "I", Some("  "), None), "# T\n\nI");
}

#[test]
fn the_offer_text_is_cut_to_the_limit_on_a_character_boundary_and_keeps_the_link() {
    let long = "é".repeat(MAX_OFFER_TEXT_BYTES);
    let link = "https://app.example/w/ws_1/tasks";
    let text = offer_text("T", &long, None, Some(link));
    assert!(text.len() <= MAX_OFFER_TEXT_BYTES);
    assert!(text.ends_with(&format!("On Podster: {link}")));
    let bare = offer_text("T", &long, None, None);
    assert!(bare.len() <= MAX_OFFER_TEXT_BYTES && bare.len() > MAX_OFFER_TEXT_BYTES - 4);
}

#[test]
fn reads_back_off_from_a_minute_to_an_hour_and_stay_there() {
    let minutes: Vec<i64> = (1..=9).map(|n| read_delay_ms(n) / 60_000).collect();
    assert_eq!(minutes, vec![1, 2, 4, 8, 16, 32, 60, 60, 60]);
    assert_eq!(read_delay_ms(0), 60_000);
    assert_eq!(read_delay_ms(u32::MAX), 3_600_000);
}

#[test]
fn reading_ends_after_seven_days_or_once_ended() {
    let sent = 1_000;
    let until = sent + READ_FOR_MS;
    assert!(reading_open(sent, until, false));
    assert!(reading_open(until - 1, until, false));
    assert!(!reading_open(until, until, false));
    assert!(!reading_open(sent, until, true));
    assert_eq!(READ_FOR_MS, 604_800_000);
}
