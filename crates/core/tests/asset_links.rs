#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use podster_core::asset_links::*;
use podster_core::files::ObjectState::{self, *};
use podster_core::submission_files::RoomFile;
use podster_core::TaskStatus;

const HASH: &str = "ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34";

fn asset(state: ObjectState) -> RoomFile<'static> {
    RoomFile {
        id: "obj_1",
        uploaded_by: "mem",
        for_task: None,
        state,
        removed: false,
        sha256: HASH,
        size: 42,
    }
}

#[test]
fn a_scanning_or_ready_input_asset_links_to_an_open_task() {
    for state in [Scanning, Ready] {
        for status in [
            TaskStatus::Open,
            TaskStatus::Offered,
            TaskStatus::Accepted,
            TaskStatus::Submitted,
        ] {
            assert_eq!(
                check_link(&asset(state), status, 0),
                Ok(()),
                "{state:?} {status:?}"
            );
        }
    }
}

#[test]
fn a_file_nobody_could_have_doesnt_link() {
    for state in [Uploading, Blocked, Failed] {
        assert_eq!(
            check_link(&asset(state), TaskStatus::Open, 0),
            Err(LinkRefusal::NotAvailable),
            "{state:?}"
        );
    }
}

#[test]
fn every_state_is_either_linkable_or_not_and_only_two_are() {
    let linkable: Vec<_> = ObjectState::ALL
        .into_iter()
        .filter(|s| linkable_state(*s))
        .collect();
    assert_eq!(linkable, vec![Scanning, Ready]);
}

#[test]
fn a_submission_file_answers_as_if_it_werent_there() {
    let mut file = asset(Ready);
    file.for_task = Some("tsk_2");
    assert_eq!(
        check_link(&file, TaskStatus::Open, 0),
        Err(LinkRefusal::NotInputAsset)
    );
    assert_eq!(LinkRefusal::NotInputAsset.code(), "file_not_found");
}

#[test]
fn a_removed_file_doesnt_link_whatever_its_state_says() {
    let mut file = asset(Ready);
    file.removed = true;
    assert_eq!(
        check_link(&file, TaskStatus::Open, 0),
        Err(LinkRefusal::Removed)
    );
}

#[test]
fn a_finished_task_takes_no_new_link() {
    for status in [TaskStatus::Completed, TaskStatus::Canceled] {
        assert_eq!(
            check_link(&asset(Ready), status, 0),
            Err(LinkRefusal::TaskClosed),
            "{status:?}"
        );
        assert!(!task_takes_links(status));
    }
    let open: Vec<_> = TaskStatus::ALL
        .into_iter()
        .filter(|s| task_takes_links(*s))
        .collect();
    assert_eq!(open.len(), 4);
}

#[test]
fn a_task_holds_at_most_the_limit() {
    assert_eq!(
        check_link(&asset(Ready), TaskStatus::Open, MAX_LINKED_ASSETS - 1),
        Ok(())
    );
    assert_eq!(
        check_link(&asset(Ready), TaskStatus::Open, MAX_LINKED_ASSETS),
        Err(LinkRefusal::TooMany)
    );
}

#[test]
fn refusals_have_stable_codes() {
    let codes: Vec<_> = [
        LinkRefusal::NotInputAsset,
        LinkRefusal::NotAvailable,
        LinkRefusal::Removed,
        LinkRefusal::TaskClosed,
        LinkRefusal::TooMany,
    ]
    .map(LinkRefusal::code)
    .to_vec();
    assert_eq!(
        codes,
        [
            "file_not_found",
            "file_not_available",
            "file_removed",
            "task_closed",
            "limit_exceeded"
        ]
    );
}
