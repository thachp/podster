#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use podster_core::a2a::*;
use podster_core::{decide, decide_create, Command, NewTask, Observed, Task, TaskStatus};
use RemoteEffect as E;
use RemoteState::*;

const AGENT: &str = "agt_remote";
const URL: &str = "https://agent.example.com/a2a";
const REMOTE: &str = "remote-task-1";
const OFFER: &str = "off_1";

// Built through `decide_create` and `decide`, so these tests don't list `Task`'s fields.
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

fn accepted() -> Task {
    let task = offered();
    step(
        &task,
        AGENT,
        Command::Accept {
            version: task.version,
        },
    )
}

fn submitted() -> Task {
    let task = accepted();
    step(
        &task,
        AGENT,
        Command::Submit {
            version: task.version,
            artifacts: vec![],
            note: Some("Done.".into()),
            commit_sha: None,
        },
    )
}

fn attempt() -> Attempt<'static> {
    Attempt {
        agent: AGENT,
        offer: OFFER,
        endpoint_url: URL,
        endpoint_version: 3,
        remote_task_id: REMOTE,
        working_seen: false,
        last_read_no: 0,
        last_state: None,
        ended: false,
    }
}

const ENDPOINT: Endpoint<'static> = Endpoint {
    url: URL,
    version: 3,
    active: true,
};

fn read(read_no: u32, state: RemoteState) -> RemoteRead<'static> {
    RemoteRead {
        read_no,
        remote_task_id: REMOTE,
        state,
    }
}

fn effect(task: &Task, attempt: &Attempt<'_>, state: RemoteState) -> RemoteEffect {
    decide_remote(
        task,
        Some(OFFER),
        attempt,
        Some(&ENDPOINT),
        &read(attempt.last_read_no + 1, state),
    )
    .effect
}

// The table in ADR 0007.

#[test]
fn before_acceptance_each_state_maps_as_the_table_says() {
    let task = offered();
    let v = task.version;
    let a = attempt();
    assert_eq!(effect(&task, &a, Submitted), E::Nothing(Ignored::NoEffect));
    assert_eq!(effect(&task, &a, Working), E::Accept { version: v });
    assert_eq!(effect(&task, &a, InputRequired), E::Message);
    assert_eq!(
        effect(&task, &a, Completed),
        E::Hold {
            working_seen: false
        }
    );
    assert_eq!(effect(&task, &a, Rejected), E::Decline { version: v });
    assert_eq!(effect(&task, &a, Failed), E::Decline { version: v });
    assert_eq!(effect(&task, &a, Canceled), E::RecordCanceled);
    assert_eq!(effect(&task, &a, AuthRequired), E::Message);
    assert_eq!(
        effect(&task, &a, Unknown),
        E::Nothing(Ignored::UnknownState)
    );
}

#[test]
fn after_acceptance_each_state_maps_as_the_table_says() {
    let task = accepted();
    let v = task.version;
    let a = attempt();
    assert_eq!(effect(&task, &a, Submitted), E::Nothing(Ignored::NoEffect));
    assert_eq!(effect(&task, &a, Working), E::Nothing(Ignored::NoEffect));
    assert_eq!(effect(&task, &a, InputRequired), E::Message);
    assert_eq!(effect(&task, &a, Completed), E::Submit { version: v });
    // REJECTED after acceptance is a release, since decline only applies to an offer.
    assert_eq!(effect(&task, &a, Rejected), E::Release { version: v });
    assert_eq!(effect(&task, &a, Failed), E::Release { version: v });
    assert_eq!(effect(&task, &a, Canceled), E::RecordCanceled);
    assert_eq!(effect(&task, &a, AuthRequired), E::Message);
    assert_eq!(
        effect(&task, &a, Unknown),
        E::Nothing(Ignored::UnknownState)
    );
}

#[test]
fn the_commands_it_names_are_ones_the_state_machine_accepts_from_the_agent() {
    let task = offered();
    let E::Accept { version } = effect(&task, &attempt(), Working) else {
        panic!("WORKING should accept");
    };
    let task = step(&task, AGENT, Command::Accept { version });
    assert_eq!(task.status, TaskStatus::Accepted);
    let E::Release { version } = effect(&task, &attempt(), Rejected) else {
        panic!("REJECTED should release");
    };
    let released = step(
        &task,
        AGENT,
        Command::Release {
            version,
            reason: RELEASE_REASON.into(),
        },
    );
    assert_eq!(released.status, TaskStatus::Open);
    let offer = offered();
    let E::Decline { version } = effect(&offer, &attempt(), Failed) else {
        panic!("FAILED should decline");
    };
    let declined = step(
        &offer,
        AGENT,
        Command::Decline {
            version,
            reason: DECLINE_REASON.into(),
        },
    );
    assert_eq!(declined.status, TaskStatus::Open);
}

#[test]
fn it_never_verifies_whatever_the_state_or_stage() {
    for task in [offered(), accepted(), submitted()] {
        for state in RemoteState::KNOWN.into_iter().chain([Unknown]) {
            let effect = effect(&task, &attempt(), state);
            // No variant approves. A completion is at most a submission or a hold.
            assert!(
                matches!(
                    effect,
                    E::Nothing(_)
                        | E::Accept { .. }
                        | E::Submit { .. }
                        | E::Decline { .. }
                        | E::Release { .. }
                        | E::Message
                        | E::Hold { .. }
                        | E::RecordCanceled
                        | E::RecordReportedFailure
                ),
                "{state:?}"
            );
            if task.status == TaskStatus::Submitted {
                assert!(
                    !matches!(
                        effect,
                        E::Submit { .. } | E::Accept { .. } | E::Release { .. }
                    ),
                    "{state:?} on a submitted task"
                );
            }
        }
    }
}

// COMPLETED and WORKING.

#[test]
fn completed_with_no_working_is_held() {
    let decision = decide_remote(
        &offered(),
        Some(OFFER),
        &attempt(),
        Some(&ENDPOINT),
        &read(1, Completed),
    );
    assert_eq!(
        decision.effect,
        E::Hold {
            working_seen: false
        }
    );
    assert!(decision.stop_reading);
    assert!(decision.applied);
}

#[test]
fn completed_after_working_was_seen_but_before_podster_recorded_acceptance_is_still_held() {
    // WORKING was read, but the accept it led to was refused or hasn't landed, so the task is still only offered.
    let a = Attempt {
        working_seen: true,
        last_read_no: 1,
        ..attempt()
    };
    assert_eq!(
        effect(&offered(), &a, Completed),
        E::Hold { working_seen: true }
    );
}

#[test]
fn working_then_completed_accepts_and_then_submits() {
    let task = offered();
    let first = decide_remote(
        &task,
        Some(OFFER),
        &attempt(),
        Some(&ENDPOINT),
        &read(1, Working),
    );
    assert_eq!(
        first.effect,
        E::Accept {
            version: task.version
        }
    );
    assert!(first.working_seen && !first.stop_reading && first.applied);
    let task = step(
        &task,
        AGENT,
        Command::Accept {
            version: task.version,
        },
    );
    let after = Attempt {
        working_seen: first.working_seen,
        last_read_no: 1,
        ..attempt()
    };
    let second = decide_remote(
        &task,
        Some(OFFER),
        &after,
        Some(&ENDPOINT),
        &read(2, Completed),
    );
    assert_eq!(
        second.effect,
        E::Submit {
            version: task.version
        }
    );
    assert!(second.stop_reading);
}

#[test]
fn a_repeated_working_before_acceptance_lands_asks_to_accept_again() {
    // The first accept may have lost a version race. Asking again is safe: the state machine refuses it once accepted.
    let a = Attempt {
        working_seen: true,
        last_read_no: 1,
        ..attempt()
    };
    let task = offered();
    assert_eq!(
        effect(&task, &a, Working),
        E::Accept {
            version: task.version
        }
    );
}

#[test]
fn auth_required_grants_nothing() {
    for task in [offered(), accepted()] {
        let decision = decide_remote(
            &task,
            Some(OFFER),
            &attempt(),
            Some(&ENDPOINT),
            &read(1, AuthRequired),
        );
        assert_eq!(decision.effect, E::Message);
        assert!(!decision.working_seen);
        assert!(!decision.stop_reading);
    }
}

#[test]
fn unknown_states_are_ignored_and_keep_reading() {
    for name in [
        "TASK_STATE_UNSPECIFIED",
        "working",
        "completed",
        "TASK_STATE_PAUSED",
        "",
    ] {
        assert_eq!(RemoteState::from_name(name), Unknown, "{name}");
    }
    let decision = decide_remote(
        &offered(),
        Some(OFFER),
        &attempt(),
        Some(&ENDPOINT),
        &read(1, Unknown),
    );
    assert_eq!(decision.effect, E::Nothing(Ignored::UnknownState));
    assert!(!decision.stop_reading);
    assert!(decision.applied);
}

#[test]
fn state_names_round_trip_and_terminal_states_end_reading() {
    for state in RemoteState::KNOWN {
        assert_eq!(RemoteState::from_name(state.name()), state);
    }
    let terminal: Vec<_> = RemoteState::KNOWN
        .into_iter()
        .filter(|s| s.is_terminal())
        .collect();
    assert_eq!(terminal, vec![Completed, Rejected, Failed, Canceled]);
    for state in RemoteState::KNOWN {
        let decision = decide_remote(
            &accepted(),
            Some(OFFER),
            &attempt(),
            Some(&ENDPOINT),
            &read(1, state),
        );
        assert_eq!(decision.stop_reading, state.is_terminal(), "{state:?}");
    }
}

// Late, duplicate and out-of-order reads.

#[test]
fn a_duplicate_read_changes_nothing() {
    let a = Attempt {
        last_read_no: 4,
        working_seen: true,
        ..attempt()
    };
    let decision = decide_remote(
        &accepted(),
        Some(OFFER),
        &a,
        Some(&ENDPOINT),
        &read(4, Completed),
    );
    assert_eq!(decision.effect, E::Nothing(Ignored::Stale));
    assert!(!decision.applied);
    assert!(!decision.stop_reading);
    assert!(decision.working_seen);
}

#[test]
fn an_out_of_order_read_older_than_the_last_applied_changes_nothing() {
    // Read 3 reported COMPLETED and was applied. Read 2's WORKING arrives afterwards.
    let a = Attempt {
        last_read_no: 3,
        ..attempt()
    };
    let decision = decide_remote(
        &offered(),
        Some(OFFER),
        &a,
        Some(&ENDPOINT),
        &read(2, Working),
    );
    assert_eq!(decision.effect, E::Nothing(Ignored::Stale));
    assert!(!decision.applied);
    assert!(!decision.working_seen);
}

#[test]
fn nothing_is_read_after_reading_ended() {
    // A held COMPLETED ended reading. A later WORKING, however new, can't then accept.
    let a = Attempt {
        last_read_no: 2,
        ended: true,
        ..attempt()
    };
    let decision = decide_remote(
        &offered(),
        Some(OFFER),
        &a,
        Some(&ENDPOINT),
        &read(3, Working),
    );
    assert_eq!(decision.effect, E::Nothing(Ignored::Ended));
    assert!(!decision.applied);
}

#[test]
fn a_late_update_after_decline_cancel_or_reassignment_changes_nothing_and_ends_reading() {
    let offer = offered();
    let declined = step(
        &offer,
        AGENT,
        Command::Decline {
            version: offer.version,
            reason: "No.".into(),
        },
    );
    let canceled = step(
        &offer,
        "req",
        Command::Cancel {
            version: offer.version,
            reason: "Not needed.".into(),
        },
    );
    let reassigned = step(
        &declined,
        "req",
        Command::Assign {
            version: declined.version,
            assignee: "agt_other".into(),
        },
    );
    for (why, task) in [
        ("declined", &declined),
        ("canceled", &canceled),
        ("reassigned", &reassigned),
    ] {
        for state in [Working, Completed, Rejected, InputRequired] {
            let decision = decide_remote(
                task,
                Some(OFFER),
                &attempt(),
                Some(&ENDPOINT),
                &read(1, state),
            );
            assert_eq!(
                decision.effect,
                E::Nothing(Ignored::NotTheAgents),
                "{why} {state:?}"
            );
            assert!(decision.stop_reading, "{why} {state:?}");
        }
    }
}

#[test]
fn a_late_completion_on_a_submitted_or_finished_task_submits_nothing_more() {
    let task = submitted();
    assert_eq!(
        effect(&task, &attempt(), Completed),
        E::Nothing(Ignored::NoEffect)
    );
    // A submitted task can't be released, so the agent's reported failure is only recorded for the reviewer.
    assert_eq!(
        effect(&task, &attempt(), Rejected),
        E::RecordReportedFailure
    );
    assert_eq!(effect(&task, &attempt(), Failed), E::RecordReportedFailure);
    let done = step(
        &task,
        "rev",
        Command::Verify {
            submission_no: task.submission_no,
            commit_sha: None,
        },
    );
    let decision = decide_remote(
        &done,
        Some(OFFER),
        &attempt(),
        Some(&ENDPOINT),
        &read(1, Completed),
    );
    assert_eq!(decision.effect, E::Nothing(Ignored::NotTheAgents));
    assert!(decision.stop_reading);
}

// The pinned endpoint.

#[test]
fn a_stale_endpoint_version_ends_reading_with_no_effect() {
    let repointed = Endpoint {
        version: 4,
        ..ENDPOINT
    };
    let moved = Endpoint {
        url: "https://elsewhere.example.com/a2a",
        ..ENDPOINT
    };
    let off = Endpoint {
        active: false,
        ..ENDPOINT
    };
    for (why, endpoint) in [
        ("re-registered", Some(&repointed)),
        ("moved", Some(&moved)),
        ("switched off", Some(&off)),
        ("deleted", None),
    ] {
        for state in [Working, Completed] {
            let decision = decide_remote(
                &offered(),
                Some(OFFER),
                &attempt(),
                endpoint,
                &read(1, state),
            );
            assert_eq!(
                decision.effect,
                E::Nothing(Ignored::EndpointChanged),
                "{why} {state:?}"
            );
            assert!(decision.stop_reading, "{why}");
            assert!(!decision.working_seen, "{why}");
        }
    }
}

#[test]
fn a_read_naming_another_remote_task_is_ignored() {
    let other = RemoteRead {
        read_no: 1,
        remote_task_id: "remote-task-2",
        state: Working,
    };
    let decision = decide_remote(&offered(), Some(OFFER), &attempt(), Some(&ENDPOINT), &other);
    assert_eq!(decision.effect, E::Nothing(Ignored::ForeignRemoteTask));
    assert!(!decision.applied && !decision.stop_reading);
}

#[test]
fn a_read_naming_an_invalid_remote_task_id_is_its_own_refusal() {
    // The API counts this one toward the endpoint's three failures in a row.
    for id in ["", "has space", "tab\tid", "é"] {
        let bad = RemoteRead {
            read_no: 1,
            remote_task_id: id,
            state: Working,
        };
        let decision = decide_remote(&offered(), Some(OFFER), &attempt(), Some(&ENDPOINT), &bad);
        assert_eq!(
            decision.effect,
            E::Nothing(Ignored::InvalidRemoteTask),
            "{id:?}"
        );
        assert!(!decision.applied && !decision.stop_reading, "{id:?}");
    }
}

#[test]
fn an_attempt_for_another_agent_never_acts_for_this_one() {
    let a = Attempt {
        agent: "agt_other",
        ..attempt()
    };
    assert_eq!(
        effect(&offered(), &a, Working),
        E::Nothing(Ignored::NotTheAgents)
    );
}

// Remote task IDs.

#[test]
fn remote_task_ids_are_short_printable_ascii_with_no_whitespace() {
    assert!(valid_remote_task_id("a"));
    assert!(valid_remote_task_id("550e8400-e29b-41d4-a716-446655440000"));
    assert!(valid_remote_task_id("tasks/abc_123:~!"));
    assert!(valid_remote_task_id(&"x".repeat(MAX_REMOTE_TASK_ID_BYTES)));
    assert!(!valid_remote_task_id(
        &"x".repeat(MAX_REMOTE_TASK_ID_BYTES + 1)
    ));
    for bad in [
        "",
        " ",
        "a b",
        "a\nb",
        "a\tb",
        "a\u{7f}",
        "a\0b",
        "tâche",
        "a\u{200b}b",
    ] {
        assert!(!valid_remote_task_id(bad), "{bad:?}");
    }
    assert_eq!(MAX_REMOTE_TASK_ID_BYTES, 256);
}

#[test]
fn reasons_are_fixed_text_that_quotes_no_remote_agent() {
    for reason in [DECLINE_REASON, RELEASE_REASON] {
        assert!(!reason.trim().is_empty());
        assert!(reason.len() <= podster_core::MAX_REASON_BYTES);
    }
}

// Each offer is its own.

#[test]
fn an_old_attempt_cant_act_on_a_new_offer_to_the_same_agent() {
    // The agent declined offer 1, and the requester offered the task to it again as offer 2.
    let offer = offered();
    let declined = step(
        &offer,
        AGENT,
        Command::Decline {
            version: offer.version,
            reason: "Not now.".into(),
        },
    );
    let reoffered = step(
        &declined,
        "req",
        Command::Assign {
            version: declined.version,
            assignee: AGENT.into(),
        },
    );
    assert_eq!(reoffered.status, TaskStatus::Offered);
    assert_eq!(reoffered.assignee.as_deref(), Some(AGENT));
    for state in [
        Working,
        Completed,
        Rejected,
        Failed,
        InputRequired,
        AuthRequired,
    ] {
        let decision = decide_remote(
            &reoffered,
            Some("off_2"),
            &attempt(),
            Some(&ENDPOINT),
            &read(1, state),
        );
        assert_eq!(
            decision.effect,
            E::Nothing(Ignored::NotTheAgents),
            "{state:?}"
        );
        assert!(decision.stop_reading && !decision.applied, "{state:?}");
    }
    // The attempt for offer 2 acts on it.
    let second = Attempt {
        offer: "off_2",
        ..attempt()
    };
    assert_eq!(
        decide_remote(
            &reoffered,
            Some("off_2"),
            &second,
            Some(&ENDPOINT),
            &read(1, Working)
        )
        .effect,
        E::Accept {
            version: reoffered.version
        }
    );
}

#[test]
fn an_old_attempt_cant_release_a_task_the_agent_accepted_again() {
    // The agent accepted offer 1, released it, was offered it again as offer 2 and accepted that.
    let first = accepted();
    let released = step(
        &first,
        AGENT,
        Command::Release {
            version: first.version,
            reason: "Stuck.".into(),
        },
    );
    let reoffered = step(
        &released,
        "req",
        Command::Assign {
            version: released.version,
            assignee: AGENT.into(),
        },
    );
    let again = step(
        &reoffered,
        AGENT,
        Command::Accept {
            version: reoffered.version,
        },
    );
    assert_eq!(again.status, TaskStatus::Accepted);
    for state in [Rejected, Failed, Completed] {
        let decision = decide_remote(
            &again,
            Some("off_2"),
            &attempt(),
            Some(&ENDPOINT),
            &read(5, state),
        );
        assert_eq!(
            decision.effect,
            E::Nothing(Ignored::NotTheAgents),
            "{state:?}"
        );
        assert!(decision.stop_reading, "{state:?}");
    }
}

#[test]
fn a_task_on_no_offer_ends_the_attempt() {
    let decision = decide_remote(
        &offered(),
        None,
        &attempt(),
        Some(&ENDPOINT),
        &read(1, Working),
    );
    assert_eq!(decision.effect, E::Nothing(Ignored::NotTheAgents));
    assert!(decision.stop_reading);
}

// Repeated messages.

#[test]
fn a_repeated_input_required_or_auth_required_posts_once() {
    for state in [InputRequired, AuthRequired] {
        for task in [offered(), accepted(), submitted()] {
            let first = decide_remote(
                &task,
                Some(OFFER),
                &attempt(),
                Some(&ENDPOINT),
                &read(1, state),
            );
            assert_eq!(first.effect, E::Message, "{state:?}");
            assert!(first.applied);
            let after = Attempt {
                last_read_no: 1,
                last_state: Some(state),
                ..attempt()
            };
            let again = decide_remote(&task, Some(OFFER), &after, Some(&ENDPOINT), &read(2, state));
            assert_eq!(again.effect, E::Nothing(Ignored::Unchanged), "{state:?}");
            assert!(again.applied && !again.stop_reading, "{state:?}");
        }
    }
}

#[test]
fn input_required_again_after_another_state_posts_again() {
    let after = Attempt {
        last_read_no: 2,
        last_state: Some(Working),
        ..attempt()
    };
    assert_eq!(effect(&accepted(), &after, InputRequired), E::Message);
    // And AUTH_REQUIRED after INPUT_REQUIRED is a change too.
    let asked = Attempt {
        last_read_no: 2,
        last_state: Some(InputRequired),
        ..attempt()
    };
    assert_eq!(effect(&accepted(), &asked, AuthRequired), E::Message);
}

#[test]
fn a_repeated_working_still_asks_to_accept_while_only_offered() {
    let after = Attempt {
        last_read_no: 1,
        last_state: Some(Working),
        working_seen: true,
        ..attempt()
    };
    let task = offered();
    assert_eq!(
        effect(&task, &after, Working),
        E::Accept {
            version: task.version
        }
    );
}
