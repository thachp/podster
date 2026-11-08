//! M3 step 9: a message that arrives over A2A is refused once its task is finished (spec 3.1.1, ADR 0007).

use podster_core::a2a::accepts_inbound_message;
use podster_core::TaskStatus;

#[test]
fn a_finished_task_takes_no_more_a2a_messages() {
    for status in [TaskStatus::Completed, TaskStatus::Canceled] {
        assert!(!accepts_inbound_message(status), "{status:?}");
    }
}

#[test]
fn every_unfinished_task_takes_a2a_messages() {
    for status in [
        TaskStatus::Open,
        TaskStatus::Offered,
        TaskStatus::Accepted,
        TaskStatus::Submitted,
    ] {
        assert!(accepts_inbound_message(status), "{status:?}");
    }
}
