#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use podster_core::*;
use TaskStatus::*;

fn task(status: TaskStatus) -> Task {
    let assigned = !matches!(status, Open);
    Task {
        id: "t".into(),
        title: "title".into(),
        instructions: "instructions".into(),
        acceptance_criteria: None,
        requester: "req".into(),
        assignee: assigned.then(|| "asg".to_string()),
        reviewer: "rev".into(),
        status,
        version: 5,
        due_at: None,
        follow_up_of: None,
        has_linked_repository: false,
        submission_no: 2,
        submission_commit: None,
        approved_submission_no: None,
        submission_files: 0,
        assignee_departed: false,
        needs_reviewer: false,
        needs_requester: false,
    }
}

fn commands() -> Vec<(&'static str, Command)> {
    vec![
        (
            "update",
            Command::Update {
                version: 5,
                patch: TaskPatch {
                    title: Some("new".into()),
                    ..Default::default()
                },
            },
        ),
        (
            "set_reviewer",
            Command::SetReviewer {
                version: 5,
                reviewer: "rev2".into(),
            },
        ),
        (
            "set_requester",
            Command::SetRequester {
                version: 5,
                requester: "req2".into(),
            },
        ),
        (
            "assign",
            Command::Assign {
                version: 5,
                assignee: "asg2".into(),
            },
        ),
        ("accept", Command::Accept { version: 5 }),
        (
            "decline",
            Command::Decline {
                version: 5,
                reason: "no".into(),
            },
        ),
        (
            "release",
            Command::Release {
                version: 5,
                reason: "no".into(),
            },
        ),
        (
            "submit",
            Command::Submit {
                version: 5,
                artifacts: vec![],
                note: Some("done".into()),
                commit_sha: None,
            },
        ),
        (
            "request_changes",
            Command::RequestChanges {
                submission_no: 2,
                reason: "fix".into(),
            },
        ),
        (
            "verify",
            Command::Verify {
                submission_no: 2,
                commit_sha: None,
            },
        ),
        (
            "cancel",
            Command::Cancel {
                version: 5,
                reason: "no".into(),
            },
        ),
    ]
}

/// The lifecycle table from PRODUCT.md. `None` means the command is an invalid transition from that status.
fn expected(command: &str, from: TaskStatus) -> Option<TaskStatus> {
    match (command, from) {
        ("update", Open | Offered | Accepted) => Some(from),
        ("set_reviewer" | "set_requester", Open | Offered | Accepted | Submitted) => Some(from),
        ("assign", Open | Offered) => Some(Offered),
        ("accept", Offered) => Some(Accepted),
        ("decline", Offered) => Some(Open),
        ("release", Accepted) => Some(Open),
        ("submit", Accepted) => Some(Submitted),
        ("request_changes", Submitted) => Some(Accepted),
        ("verify", Submitted) => Some(Completed),
        ("cancel", Open | Offered | Accepted | Submitted) => Some(Canceled),
        _ => None,
    }
}

#[test]
fn every_status_and_command_matches_the_lifecycle_table() {
    let mut checked = 0;
    for from in TaskStatus::ALL {
        for (name, command) in commands() {
            let result = decide(&task(from), "actor", command, &Observed::default());
            match expected(name, from) {
                Some(to) => {
                    let decision = result.unwrap_or_else(|e| panic!("{name} from {from:?}: {e:?}"));
                    assert_eq!(decision.task.status, to, "{name} from {from:?}");
                    assert_eq!(decision.task.version, 6, "{name} bumps the version");
                    assert!(!decision.events.is_empty(), "{name} records an event");
                }
                None => assert_eq!(
                    result.unwrap_err(),
                    CoreError::InvalidTransition,
                    "{name} from {from:?}"
                ),
            }
            checked += 1;
        }
    }
    assert_eq!(checked, 66);
}

#[test]
fn stale_versions_never_apply() {
    for from in TaskStatus::ALL {
        for (name, command) in commands() {
            let stale = match command {
                Command::Update { patch, .. } => Command::Update { version: 4, patch },
                Command::SetReviewer { reviewer, .. } => Command::SetReviewer {
                    version: 4,
                    reviewer,
                },
                Command::SetRequester { requester, .. } => Command::SetRequester {
                    version: 4,
                    requester,
                },
                Command::Assign { assignee, .. } => Command::Assign {
                    version: 4,
                    assignee,
                },
                Command::Accept { .. } => Command::Accept { version: 4 },
                Command::Decline { reason, .. } => Command::Decline { version: 4, reason },
                Command::Release { reason, .. } => Command::Release { version: 4, reason },
                Command::Submit {
                    artifacts,
                    note,
                    commit_sha,
                    ..
                } => Command::Submit {
                    version: 4,
                    artifacts,
                    note,
                    commit_sha,
                },
                Command::Cancel { reason, .. } => Command::Cancel { version: 4, reason },
                Command::RequestChanges { .. } | Command::Verify { .. } => continue,
            };
            assert_eq!(
                decide(&task(from), "actor", stale, &Observed::default()).unwrap_err(),
                CoreError::VersionConflict,
                "{name}"
            );
        }
    }
}

#[test]
fn create_defaults_the_reviewer_and_offers_when_assigned() {
    let new = |assignee: Option<&str>, reviewer: Option<&str>| NewTask {
        id: "t".into(),
        title: "title".into(),
        instructions: "do it".into(),
        acceptance_criteria: None,
        assignee: assignee.map(Into::into),
        reviewer: reviewer.map(Into::into),
        due_at: None,
        follow_up_of: None,
        has_linked_repository: false,
    };
    let open = decide_create("req", new(None, None)).unwrap();
    assert_eq!(
        (open.task.status, open.task.reviewer.as_str()),
        (Open, "req")
    );
    let offered = decide_create("req", new(Some("asg"), None)).unwrap();
    assert_eq!(offered.task.status, Offered);
    assert!(offered.events[0].recipients.contains("asg"));
    assert_eq!(
        decide_create("req", new(Some("req"), None)).unwrap_err(),
        CoreError::SelfSignOff
    );
    assert_eq!(
        decide_create("req", new(Some("asg"), Some("asg"))).unwrap_err(),
        CoreError::SelfSignOff
    );
    assert_eq!(
        decide_create(
            "req",
            NewTask {
                title: "  ".into(),
                ..new(None, None)
            }
        )
        .unwrap_err(),
        CoreError::InvalidArgument("title")
    );
}

#[test]
fn nobody_signs_off_their_own_work() {
    let submitted = task(Submitted);
    let cmd = || Command::Verify {
        submission_no: 2,
        commit_sha: None,
    };
    assert_eq!(
        decide(&submitted, "asg", cmd(), &Observed::default()).unwrap_err(),
        CoreError::SelfSignOff
    );
    let set = Command::SetReviewer {
        version: 5,
        reviewer: "asg".into(),
    };
    assert_eq!(
        decide(&submitted, "req", set, &Observed::default()).unwrap_err(),
        CoreError::SelfSignOff
    );
    let assign = Command::Assign {
        version: 5,
        assignee: "rev".into(),
    };
    assert_eq!(
        decide(&task(Open), "req", assign, &Observed::default()).unwrap_err(),
        CoreError::SelfSignOff
    );
}

#[test]
fn reviews_bind_to_one_submission() {
    let verify = Command::Verify {
        submission_no: 1,
        commit_sha: None,
    };
    assert_eq!(
        decide(&task(Submitted), "rev", verify, &Observed::default()).unwrap_err(),
        CoreError::SubmissionMismatch
    );
    let changes = Command::RequestChanges {
        submission_no: 3,
        reason: "x".into(),
    };
    assert_eq!(
        decide(&task(Submitted), "rev", changes, &Observed::default()).unwrap_err(),
        CoreError::SubmissionMismatch
    );
}

#[test]
fn material_edits_need_acceptance_again() {
    let accepted = task(Accepted);
    let edit = |patch| Command::Update { version: 5, patch };
    let title = edit(TaskPatch {
        title: Some("new".into()),
        ..Default::default()
    });
    assert_eq!(
        decide(&accepted, "req", title, &Observed::default())
            .unwrap()
            .task
            .status,
        Accepted
    );
    let same = edit(TaskPatch {
        instructions: Some("instructions".into()),
        ..Default::default()
    });
    assert_eq!(
        decide(&accepted, "req", same, &Observed::default())
            .unwrap()
            .task
            .status,
        Accepted
    );
    let body = edit(TaskPatch {
        instructions: Some("changed".into()),
        ..Default::default()
    });
    assert_eq!(
        decide(&accepted, "req", body, &Observed::default())
            .unwrap()
            .task
            .status,
        Offered
    );
    let criteria = edit(TaskPatch {
        acceptance_criteria: Some("new".into()),
        ..Default::default()
    });
    assert_eq!(
        decide(&accepted, "req", criteria, &Observed::default())
            .unwrap()
            .task
            .status,
        Offered
    );
}

#[test]
fn submit_needs_content_and_respects_limits() {
    let accepted = task(Accepted);
    let submit = |artifacts: Vec<Artifact>, note: Option<&str>| Command::Submit {
        version: 5,
        artifacts,
        note: note.map(Into::into),
        commit_sha: None,
    };
    assert_eq!(
        decide(&accepted, "asg", submit(vec![], None), &Observed::default()).unwrap_err(),
        CoreError::InvalidArgument("artifacts")
    );
    assert_eq!(
        decide(
            &accepted,
            "asg",
            submit(vec![], Some("  ")),
            &Observed::default()
        )
        .unwrap_err(),
        CoreError::InvalidArgument("artifacts")
    );
    let artifact = Artifact {
        uri: "https://x.test".into(),
        label: "x".into(),
    };
    assert!(decide(
        &accepted,
        "asg",
        submit(vec![artifact.clone(); MAX_ARTIFACTS], None),
        &Observed::default()
    )
    .is_ok());
    assert!(decide(
        &accepted,
        "asg",
        submit(vec![artifact; MAX_ARTIFACTS + 1], None),
        &Observed::default()
    )
    .is_err());
    let next = decide(
        &accepted,
        "asg",
        submit(vec![], Some("done")),
        &Observed::default(),
    )
    .unwrap();
    assert_eq!(next.task.submission_no, 3);
}

#[test]
fn linked_repositories_pin_the_reviewed_commit() {
    let (abc, def) = (&*"ab".repeat(20), &*"de".repeat(20));
    let linked = Task {
        has_linked_repository: true,
        ..task(Accepted)
    };
    let submit = |sha: Option<&str>| Command::Submit {
        version: 5,
        artifacts: vec![],
        note: Some("n".into()),
        commit_sha: sha.map(Into::into),
    };
    assert_eq!(
        decide(&linked, "asg", submit(None), &Observed::default()).unwrap_err(),
        CoreError::InvalidArgument("commit_sha")
    );
    let moved = Observed {
        head_sha: Some(def.into()),
        ..Observed::default()
    };
    assert_eq!(
        decide(&linked, "asg", submit(Some(abc)), &moved).unwrap_err(),
        CoreError::CommitChanged
    );
    let submitted = decide(&linked, "asg", submit(Some(abc)), &Observed::default())
        .unwrap()
        .task;

    let verify = |sha: Option<&str>| Command::Verify {
        submission_no: 3,
        commit_sha: sha.map(Into::into),
    };
    assert_eq!(
        decide(&submitted, "rev", verify(None), &Observed::default()).unwrap_err(),
        CoreError::InvalidArgument("commit_sha")
    );
    assert_eq!(
        decide(&submitted, "rev", verify(Some(def)), &Observed::default()).unwrap_err(),
        CoreError::CommitChanged
    );
    assert_eq!(
        decide(&submitted, "rev", verify(Some(abc)), &moved).unwrap_err(),
        CoreError::CommitChanged
    );
    assert_eq!(
        decide(
            &submitted,
            "rev",
            verify(Some(abc)),
            &Observed {
                head_sha: Some(abc.into()),
                ..Observed::default()
            }
        )
        .unwrap()
        .task
        .status,
        Completed
    );
}

#[test]
fn events_reach_the_right_people_and_never_the_actor() {
    let recipients = |status, actor: &str, command| {
        let decision = decide(&task(status), actor, command, &Observed::default()).unwrap();
        decision.events[0]
            .recipients
            .iter()
            .cloned()
            .collect::<Vec<_>>()
            .join(",")
    };
    assert_eq!(
        recipients(Offered, "asg", Command::Accept { version: 5 }),
        "req,rev"
    );
    assert_eq!(
        recipients(
            Accepted,
            "asg",
            Command::Submit {
                version: 5,
                artifacts: vec![],
                note: Some("n".into()),
                commit_sha: None
            }
        ),
        "rev"
    );
    assert_eq!(
        recipients(
            Submitted,
            "rev",
            Command::RequestChanges {
                submission_no: 2,
                reason: "x".into()
            }
        ),
        "asg"
    );
    assert_eq!(
        recipients(
            Submitted,
            "rev",
            Command::Verify {
                submission_no: 2,
                commit_sha: None
            }
        ),
        "asg,req"
    );
    assert_eq!(
        recipients(
            Offered,
            "req",
            Command::Cancel {
                version: 5,
                reason: "x".into()
            }
        ),
        "asg,rev"
    );
}

#[test]
fn status_names_round_trip() {
    for status in TaskStatus::ALL {
        assert_eq!(TaskStatus::from_name(status.name()), Some(status));
    }
    assert_eq!(TaskStatus::from_name("in_progress"), None);
}

#[test]
fn event_names_are_stable() {
    assert_eq!(EventKind::TaskOffered.name(), "task.offered");
    assert_eq!(EventKind::TaskCompleted.name(), "task.completed");
    assert_eq!(CoreError::VersionConflict.code(), "version_conflict");
}

mod departures {
    use super::*;

    #[test]
    fn assignee_leaving_active_work_reopens_it() {
        for status in [Offered, Accepted] {
            let next = apply_departure(&task(status), "asg", true).unwrap().task;
            assert_eq!((next.status, next.assignee), (Open, None));
        }
    }

    #[test]
    fn assignee_leaving_a_submission_keeps_it_reviewable() {
        let next = apply_departure(&task(Submitted), "asg", true).unwrap().task;
        assert_eq!(next.status, Submitted);
        assert!(next.assignee_departed);
        let changes = Command::RequestChanges {
            submission_no: 2,
            reason: "x".into(),
        };
        let reopened = decide(&next, "rev", changes, &Observed::default())
            .unwrap()
            .task;
        assert_eq!((reopened.status, reopened.assignee), (Open, None));
        let verify = Command::Verify {
            submission_no: 2,
            commit_sha: None,
        };
        assert_eq!(
            decide(&next, "rev", verify, &Observed::default())
                .unwrap()
                .task
                .status,
            Completed
        );
    }

    #[test]
    fn reviewer_falls_back_only_to_an_eligible_requester() {
        assert_eq!(
            apply_departure(&task(Submitted), "rev", true)
                .unwrap()
                .task
                .reviewer,
            "req"
        );
        let ineligible = apply_departure(&task(Submitted), "rev", false)
            .unwrap()
            .task;
        assert_eq!(ineligible.reviewer, "rev");
        assert!(ineligible.needs_reviewer);
        let self_review = Task {
            requester: "asg".into(),
            ..task(Submitted)
        };
        assert!(
            apply_departure(&self_review, "rev", true)
                .unwrap()
                .task
                .needs_reviewer
        );
    }

    #[test]
    fn fixing_the_reviewer_doesnt_clear_a_missing_requester() {
        let both = Task {
            reviewer: "req".into(),
            ..task(Accepted)
        };
        let next = apply_departure(&both, "req", true).unwrap().task;
        assert!(next.needs_reviewer && next.needs_requester);
        let cmd = Command::SetReviewer {
            version: next.version,
            reviewer: "rev2".into(),
        };
        let fixed = decide(&next, "admin", cmd, &Observed::default())
            .unwrap()
            .task;
        assert!(!fixed.needs_reviewer && fixed.needs_requester && fixed.needs_attention());
    }

    #[test]
    fn departures_never_complete_a_task_or_touch_finished_ones() {
        for status in TaskStatus::ALL {
            for who in ["asg", "rev", "req"] {
                if let Some(d) = apply_departure(&task(status), who, true) {
                    assert!(!d.task.status.is_terminal(), "{who} from {status:?}");
                    assert_eq!(d.task.version, 6);
                }
            }
            assert!(apply_departure(&task(status), "stranger", true).is_none());
        }
        assert!(apply_departure(&task(Completed), "asg", true).is_none());
        assert!(apply_departure(&task(Canceled), "req", true).is_none());
    }
}

/// Small deterministic generator, so a failure reproduces from its seed.
struct Rng(u64);
impl Rng {
    fn next(&mut self, bound: usize) -> usize {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        (self.0 % bound as u64) as usize
    }
}

#[test]
fn invariants_hold_across_random_command_sequences() {
    let people = ["a", "b", "c", "d"];
    let mut completions = 0;
    for seed in 1..=2_000u64 {
        let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
        let requester = people[rng.next(4)];
        let new = NewTask {
            id: "t".into(),
            title: "x".into(),
            instructions: "y".into(),
            acceptance_criteria: None,
            assignee: None,
            reviewer: None,
            due_at: None,
            follow_up_of: None,
            has_linked_repository: false,
        };
        let mut current = decide_create(requester, new).unwrap().task;
        for _ in 0..40 {
            let actor = people[rng.next(4)];
            // Departures run between commands, so the invariants cover those paths too.
            if rng.next(10) == 0 {
                let departed = people[rng.next(4)];
                if let Some(d) = apply_departure(&current, departed, rng.next(2) == 0) {
                    assert!(
                        !d.task.status.is_terminal(),
                        "seed {seed}: departures don't finish tasks"
                    );
                    assert_ne!(
                        d.task.assignee.as_deref(),
                        Some(d.task.reviewer.as_str()),
                        "seed {seed}: departure made the assignee review"
                    );
                    assert!(
                        d.task.version > current.version,
                        "seed {seed}: version must grow"
                    );
                    current = d.task;
                }
            }
            let other = people[rng.next(4)].to_string();
            let v = current.version;
            let s = current.submission_no;
            let command = match rng.next(11) {
                0 => Command::Update {
                    version: v,
                    patch: TaskPatch {
                        instructions: Some(format!("i{}", rng.next(3))),
                        ..Default::default()
                    },
                },
                1 => Command::SetReviewer {
                    version: v,
                    reviewer: other,
                },
                2 => Command::SetRequester {
                    version: v,
                    requester: other,
                },
                3 => Command::Assign {
                    version: v,
                    assignee: other,
                },
                4 => Command::Accept { version: v },
                5 => Command::Decline {
                    version: v,
                    reason: "r".into(),
                },
                6 => Command::Release {
                    version: v,
                    reason: "r".into(),
                },
                7 => Command::Submit {
                    version: v,
                    artifacts: vec![],
                    note: Some("n".into()),
                    commit_sha: None,
                },
                8 => Command::RequestChanges {
                    submission_no: s,
                    reason: "r".into(),
                },
                9 => Command::Verify {
                    submission_no: s,
                    commit_sha: None,
                },
                _ => Command::Cancel {
                    version: v,
                    reason: "r".into(),
                },
            };
            let verifying = matches!(command, Command::Verify { .. });
            let was = current.clone();
            if let Ok(decision) = decide(&current, actor, command, &Observed::default()) {
                let next = decision.task;
                assert!(next.version > was.version, "seed {seed}: version must grow");
                assert_ne!(
                    next.assignee.as_deref(),
                    Some(next.reviewer.as_str()),
                    "seed {seed}: reviewer is the assignee"
                );
                assert!(
                    !was.status.is_terminal(),
                    "seed {seed}: terminal tasks don't change"
                );
                if next.status == Completed {
                    assert!(
                        verifying && was.status == Submitted,
                        "seed {seed}: only review completes"
                    );
                    assert_ne!(
                        was.assignee.as_deref(),
                        Some(actor),
                        "seed {seed}: self sign-off"
                    );
                    completions += 1;
                }
                assert!(
                    next.submission_no >= was.submission_no,
                    "seed {seed}: submissions don't rewind"
                );
                current = next;
            }
        }
    }
    assert!(completions > 0, "the walk must actually reach completion");
}

#[test]
fn reasons_reach_the_events_that_need_them() {
    let reason_of = |status, actor: &str, command| {
        decide(&task(status), actor, command, &Observed::default())
            .unwrap()
            .events[0]
            .reason
            .clone()
    };
    assert_eq!(
        reason_of(
            Offered,
            "asg",
            Command::Decline {
                version: 5,
                reason: "busy".into()
            }
        )
        .as_deref(),
        Some("busy")
    );
    assert_eq!(
        reason_of(
            Accepted,
            "asg",
            Command::Release {
                version: 5,
                reason: "stuck".into()
            }
        )
        .as_deref(),
        Some("stuck")
    );
    assert_eq!(
        reason_of(
            Submitted,
            "rev",
            Command::RequestChanges {
                submission_no: 2,
                reason: "tests".into()
            }
        )
        .as_deref(),
        Some("tests")
    );
    assert_eq!(
        reason_of(
            Open,
            "req",
            Command::Cancel {
                version: 5,
                reason: "moot".into()
            }
        )
        .as_deref(),
        Some("moot")
    );
    assert_eq!(
        reason_of(Offered, "asg", Command::Accept { version: 5 }),
        None
    );
}

#[test]
fn assignment_rules_for_self_and_re_offers() {
    let assign = |assignee: &str| Command::Assign {
        version: 5,
        assignee: assignee.into(),
    };
    assert_eq!(
        decide(&task(Open), "admin", assign("admin"), &Observed::default()).unwrap_err(),
        CoreError::NotAllowed
    );
    let own = Task {
        reviewer: "rev".into(),
        ..task(Open)
    };
    assert_eq!(
        decide(&own, "req", assign("req"), &Observed::default())
            .unwrap()
            .task
            .assignee
            .as_deref(),
        Some("req")
    );
    assert_eq!(
        decide(&task(Offered), "req", assign("asg"), &Observed::default()).unwrap_err(),
        CoreError::InvalidTransition
    );
    assert_eq!(
        decide(&task(Offered), "req", assign("asg2"), &Observed::default())
            .unwrap()
            .task
            .assignee
            .as_deref(),
        Some("asg2")
    );
}

#[test]
fn inputs_have_limits() {
    let update = |patch| Command::Update { version: 5, patch };
    let long = |n: usize| "x".repeat(n);
    assert_eq!(
        decide(
            &task(Open),
            "req",
            update(TaskPatch::default()),
            &Observed::default()
        )
        .unwrap_err(),
        CoreError::InvalidArgument("patch")
    );
    assert!(decide(
        &task(Open),
        "req",
        update(TaskPatch {
            title: Some(long(MAX_TITLE_BYTES)),
            ..Default::default()
        }),
        &Observed::default()
    )
    .is_ok());
    assert!(decide(
        &task(Open),
        "req",
        update(TaskPatch {
            title: Some(long(MAX_TITLE_BYTES + 1)),
            ..Default::default()
        }),
        &Observed::default()
    )
    .is_err());
    assert!(decide(
        &task(Open),
        "req",
        Command::Cancel {
            version: 5,
            reason: long(MAX_REASON_BYTES + 1)
        },
        &Observed::default()
    )
    .is_err());
    let artifact = |uri: &str| Artifact {
        uri: uri.into(),
        label: "x".into(),
    };
    let submit = |artifacts| Command::Submit {
        version: 5,
        artifacts,
        note: None,
        commit_sha: None,
    };
    assert!(decide(
        &task(Accepted),
        "asg",
        submit(vec![artifact("https://ok.test")]),
        &Observed::default()
    )
    .is_ok());
    for bad in ["javascript:alert(1)", "http://x.test", ""] {
        assert_eq!(
            decide(
                &task(Accepted),
                "asg",
                submit(vec![artifact(bad)]),
                &Observed::default()
            )
            .unwrap_err(),
            CoreError::InvalidArgument("uri"),
            "{bad}"
        );
    }
    let long_note = Command::Submit {
        version: 5,
        artifacts: vec![],
        note: Some(long(MAX_NOTE_BYTES + 1)),
        commit_sha: None,
    };
    assert_eq!(
        decide(&task(Accepted), "asg", long_note, &Observed::default()).unwrap_err(),
        CoreError::InvalidArgument("note")
    );
}

#[test]
fn finishing_a_task_clears_its_attention_flags() {
    let flagged = Task {
        needs_reviewer: true,
        needs_requester: true,
        ..task(Submitted)
    };
    let done = decide(
        &flagged,
        "admin",
        Command::Cancel {
            version: 5,
            reason: "x".into(),
        },
        &Observed::default(),
    )
    .unwrap()
    .task;
    assert!(!done.needs_attention());
}

#[test]
fn references_are_short_and_links_are_clean() {
    let long = "x".repeat(MAX_REFERENCE_BYTES + 1);
    let submit = Command::Submit {
        version: 5,
        artifacts: vec![],
        note: Some("n".into()),
        commit_sha: Some(long.clone()),
    };
    assert_eq!(
        decide(&task(Accepted), "asg", submit, &Observed::default()).unwrap_err(),
        CoreError::InvalidArgument("commit_sha")
    );
    let verify = Command::Verify {
        submission_no: 2,
        commit_sha: Some(long.clone()),
    };
    assert_eq!(
        decide(&task(Submitted), "rev", verify, &Observed::default()).unwrap_err(),
        CoreError::InvalidArgument("commit_sha")
    );
    let new = NewTask {
        id: "t".into(),
        title: "x".into(),
        instructions: "y".into(),
        acceptance_criteria: None,
        assignee: None,
        reviewer: None,
        due_at: None,
        follow_up_of: Some(long),
        has_linked_repository: false,
    };
    assert_eq!(
        decide_create("req", new).unwrap_err(),
        CoreError::InvalidArgument("follow_up_of")
    );
    for bad in [
        "https://",
        "https://u:p@evil.test/",
        "https://a b",
        "https://a\nb",
        "https:///path",
    ] {
        let artifact = Artifact {
            uri: bad.into(),
            label: "x".into(),
        };
        let cmd = Command::Submit {
            version: 5,
            artifacts: vec![artifact],
            note: None,
            commit_sha: None,
        };
        assert_eq!(
            decide(&task(Accepted), "asg", cmd, &Observed::default()).unwrap_err(),
            CoreError::InvalidArgument("uri"),
            "{bad}"
        );
    }
}

#[test]
fn a_replaced_assignee_hears_about_it_as_a_reassignment() {
    let cmd = Command::Assign {
        version: 5,
        assignee: "asg2".into(),
    };
    let events = decide(&task(Offered), "req", cmd, &Observed::default())
        .unwrap()
        .events;
    assert_eq!(events[0].kind, EventKind::TaskOffered);
    assert!(events[0].recipients.contains("asg2") && !events[0].recipients.contains("asg"));
    assert_eq!(events[1].kind, EventKind::TaskReassigned);
    assert!(events[1].recipients.contains("asg"));
}

#[test]
fn a_brief_has_limits_and_may_be_absent() {
    use podster_core::{validate_brief, CoreError, MAX_CONTEXT_BYTES, MAX_GOAL_BYTES};
    assert_eq!(validate_brief(None, None), Ok(()));
    assert_eq!(validate_brief(Some("Ship it"), Some("Notes")), Ok(()));
    let goal = "g".repeat(MAX_GOAL_BYTES);
    let context = "c".repeat(MAX_CONTEXT_BYTES);
    assert_eq!(validate_brief(Some(&goal), Some(&context)), Ok(()));
    let long_goal = "g".repeat(MAX_GOAL_BYTES + 1);
    let long_context = "c".repeat(MAX_CONTEXT_BYTES + 1);
    assert_eq!(
        validate_brief(Some(&long_goal), None),
        Err(CoreError::InvalidArgument("goal"))
    );
    assert_eq!(
        validate_brief(None, Some(&long_context)),
        Err(CoreError::InvalidArgument("context"))
    );
    assert_eq!(
        validate_brief(Some("  \n"), None),
        Err(CoreError::InvalidArgument("goal"))
    );
    assert_eq!(
        validate_brief(None, Some("")),
        Err(CoreError::InvalidArgument("context"))
    );
}

#[test]
fn losing_review_changes_only_the_reviewer_and_only_on_open_tasks() {
    let named = Task {
        requester: "req".into(),
        assignee: Some("asg".into()),
        reviewer: "rev".into(),
        ..task(Submitted)
    };
    let to_requester = apply_review_ended(&named, "rev", true).unwrap();
    assert_eq!(to_requester.task.reviewer, "req");
    assert_eq!(to_requester.task.status, Submitted);
    assert_eq!(to_requester.task.assignee.as_deref(), Some("asg"));
    assert!(!to_requester.task.needs_reviewer);
    assert_eq!(to_requester.task.version, named.version + 1);
    let flagged = apply_review_ended(&named, "rev", false).unwrap();
    assert_eq!(flagged.task.reviewer, "rev");
    assert!(flagged.task.needs_reviewer);
    assert!(apply_review_ended(&named, "someone_else", true).is_none());
    assert!(apply_review_ended(
        &Task {
            status: Completed,
            ..named.clone()
        },
        "rev",
        true
    )
    .is_none());
    // A requester who's also the assignee can't take over.
    let own = Task {
        assignee: Some("req".into()),
        ..named
    };
    assert!(
        apply_review_ended(&own, "rev", true)
            .unwrap()
            .task
            .needs_reviewer
    );
}

#[test]
fn a_role_has_limits() {
    assert_eq!(validate_role("Engineer", "Builds it", 1), Ok(()));
    assert_eq!(
        validate_role(
            &"t".repeat(MAX_ROLE_TITLE_BYTES),
            &"r".repeat(MAX_RESPONSIBILITIES_BYTES),
            MAX_ROLE_CAPACITY
        ),
        Ok(())
    );
    assert_eq!(
        validate_role(&"t".repeat(MAX_ROLE_TITLE_BYTES + 1), "r", 1),
        Err(CoreError::InvalidArgument("title"))
    );
    assert_eq!(
        validate_role("t", &"r".repeat(MAX_RESPONSIBILITIES_BYTES + 1), 1),
        Err(CoreError::InvalidArgument("responsibilities"))
    );
    assert_eq!(
        validate_role(" ", "r", 1),
        Err(CoreError::InvalidArgument("title"))
    );
    assert_eq!(
        validate_role("t", "", 1),
        Err(CoreError::InvalidArgument("responsibilities"))
    );
    for capacity in [0, -1, MAX_ROLE_CAPACITY + 1] {
        assert_eq!(
            validate_role("t", "r", capacity),
            Err(CoreError::InvalidArgument("capacity"))
        );
    }
}

#[test]
fn a_claim_needs_an_invite_and_an_opening_and_asking_again_takes_nothing() {
    let free = ClaimState {
        holds_this: false,
        holds_another: false,
        invited: true,
        filled: 0,
        capacity: 1,
    };
    assert_eq!(decide_claim(&free), Ok(ClaimOutcome::Claim));
    assert_eq!(
        decide_claim(&ClaimState { filled: 1, ..free }),
        Err(ClaimRefusal::Full)
    );
    assert_eq!(
        decide_claim(&ClaimState { filled: 2, ..free }),
        Err(ClaimRefusal::Full)
    );
    assert_eq!(
        decide_claim(&ClaimState {
            holds_another: true,
            ..free
        }),
        Err(ClaimRefusal::HoldsAnother)
    );
    assert_eq!(
        decide_claim(&ClaimState {
            invited: false,
            ..free
        }),
        Err(ClaimRefusal::NotInvited)
    );
    // Someone uninvited learns nothing about whether it's full or what else they hold.
    assert_eq!(
        decide_claim(&ClaimState {
            invited: false,
            filled: 1,
            holds_another: true,
            ..free
        }),
        Err(ClaimRefusal::NotInvited)
    );
    // Asking again, even once it's over capacity, isn't a new claim.
    assert_eq!(
        decide_claim(&ClaimState {
            holds_this: true,
            invited: false,
            filled: 5,
            capacity: 1,
            holds_another: false
        }),
        Ok(ClaimOutcome::AlreadyHeld)
    );
}

#[test]
fn handoffs_are_offers_submissions_and_change_requests_between_two_participants() {
    let named = Task {
        requester: "req".into(),
        assignee: Some("asg".into()),
        reviewer: "rev".into(),
        ..task(Submitted)
    };
    assert_eq!(
        handoff_of(EventKind::TaskOffered, "req", &named),
        Some((HandoffKind::Offer, "asg"))
    );
    // A reassignment's own event tells the old assignee, and the offer that comes with it is the handoff.
    assert_eq!(handoff_of(EventKind::TaskReassigned, "req", &named), None);
    assert_eq!(
        handoff_of(EventKind::TaskSubmitted, "asg", &named),
        Some((HandoffKind::Submission, "rev"))
    );
    assert_eq!(
        handoff_of(EventKind::TaskChangesRequested, "rev", &named),
        Some((HandoffKind::ChangeRequest, "asg"))
    );
    // Handing work to yourself isn't a handoff, and nor is anything else that happens to a task.
    assert_eq!(handoff_of(EventKind::TaskOffered, "asg", &named), None);
    assert_eq!(handoff_of(EventKind::TaskAccepted, "asg", &named), None);
    assert_eq!(handoff_of(EventKind::TaskCompleted, "rev", &named), None);
    assert_eq!(
        handoff_of(EventKind::TaskNeedsAttention, "req", &named),
        None
    );
    // Changes requested on a task whose assignee left go to nobody.
    let open = Task {
        assignee: None,
        ..named
    };
    assert_eq!(
        handoff_of(EventKind::TaskChangesRequested, "rev", &open),
        None
    );
    assert_eq!(HandoffKind::ChangeRequest.name(), "change_request");
}

#[test]
fn a_planned_relationship_joins_two_roles_with_a_bounded_label() {
    assert_eq!(
        validate_planned_relationship("rol_a", "rol_b", "Hands designs to"),
        Ok(())
    );
    assert_eq!(
        validate_planned_relationship("rol_a", "rol_a", "Itself"),
        Err(CoreError::InvalidArgument("to_role_id"))
    );
    assert_eq!(
        validate_planned_relationship("rol_a", "rol_b", "  "),
        Err(CoreError::InvalidArgument("label"))
    );
    let longest = "l".repeat(MAX_PLANNED_LABEL_BYTES);
    assert_eq!(
        validate_planned_relationship("rol_a", "rol_b", &longest),
        Ok(())
    );
    assert_eq!(
        validate_planned_relationship("rol_a", "rol_b", &format!("{longest}l")),
        Err(CoreError::InvalidArgument("label"))
    );
}

fn ids(list: &[&str]) -> Vec<String> {
    list.iter().map(|id| (*id).to_string()).collect()
}

fn edges(list: &[(&str, &str)]) -> Vec<(String, String)> {
    list.iter()
        .map(|(from, to)| ((*from).to_string(), (*to).to_string()))
        .collect()
}

#[test]
fn a_plan_belongs_to_its_successor_while_the_task_is_unfinished() {
    let change = |adds, duration, canceled| PlanChange {
        adds_predecessors: adds,
        changes_duration: duration,
        removes_only_canceled: canceled,
    };
    for status in [Open, Offered, Accepted, Submitted] {
        assert_eq!(
            plan_change_allowed(status, change(true, true, false)),
            Ok(())
        );
    }
    for status in [Completed, Canceled] {
        let refused = Err(CoreError::InvalidTransition);
        assert_eq!(
            plan_change_allowed(status, change(true, false, false)),
            refused
        );
        assert_eq!(
            plan_change_allowed(status, change(false, true, false)),
            refused
        );
        assert_eq!(
            plan_change_allowed(status, change(false, false, false)),
            refused
        );
        // Removing a canceled predecessor, and nothing else, so its finish isn't withheld for good.
        assert_eq!(
            plan_change_allowed(status, change(false, false, true)),
            Ok(())
        );
        assert_eq!(
            plan_change_allowed(status, change(true, false, true)),
            refused
        );
        assert_eq!(
            plan_change_allowed(status, change(false, true, true)),
            refused
        );
    }
}

#[test]
fn a_duration_is_whole_days_from_1_to_260_and_blank_means_not_estimated() {
    let duration = |days| validate_task_plan("t", days, &[]);
    assert_eq!(duration(None), Ok(()));
    assert_eq!(duration(Some(1)), Ok(()));
    assert_eq!(duration(Some(260)), Ok(()));
    for days in [0, -1, 261] {
        assert_eq!(
            duration(Some(days)),
            Err(CoreError::InvalidArgument("duration_days"))
        );
    }
}

#[test]
fn predecessors_refuse_itself_a_duplicate_and_too_many() {
    let bad = Err(CoreError::InvalidArgument("predecessors"));
    assert_eq!(validate_task_plan("t", None, &ids(&["t"])), bad);
    assert_eq!(validate_task_plan("t", None, &ids(&["a", "a"])), bad);
    let fifty: Vec<String> = (0..50).map(|n| format!("p{n}")).collect();
    assert_eq!(validate_task_plan("t", None, &fifty), Ok(()));
    let more: Vec<String> = (0..51).map(|n| format!("p{n}")).collect();
    assert_eq!(validate_task_plan("t", None, &more), bad);
}

#[test]
fn a_loop_is_refused_however_long_and_a_diamond_is_not_one() {
    // a -> b -> c, so a can't come after c.
    let chain = edges(&[("a", "b"), ("b", "c")]);
    assert!(plan_would_cycle("a", &ids(&["c"]), &chain));
    assert!(plan_would_cycle("a", &ids(&["b"]), &chain));
    assert!(!plan_would_cycle("c", &ids(&["a"]), &chain));
    let diamond = edges(&[("a", "b"), ("a", "c"), ("b", "d")]);
    assert!(!plan_would_cycle("d", &ids(&["b", "c"]), &diamond));
    assert!(!plan_would_cycle("x", &[], &chain));
}

#[test]
fn a_cycle_check_ignores_the_edges_being_replaced_and_stops_on_a_stored_loop() {
    // b's own edge from a is what's being replaced, so moving it doesn't close a loop through it.
    assert!(!plan_would_cycle(
        "b",
        &ids(&["c"]),
        &edges(&[("a", "b"), ("x", "c")])
    ));
    // A loop already stored, which shouldn't exist, can't make this run forever.
    assert!(!plan_would_cycle(
        "t",
        &ids(&["a"]),
        &edges(&[("a", "b"), ("b", "a")])
    ));
}

#[test]
fn approving_records_the_exact_submission_and_nothing_else_touches_it() {
    let observed = Observed::default();
    let mut submitted = task(Submitted);
    submitted.submission_no = 3;
    let verify = |no| Command::Verify {
        submission_no: no,
        commit_sha: None,
    };
    let approved = decide(&submitted, "rev", verify(3), &observed)
        .unwrap()
        .task;
    assert_eq!(approved.approved_submission_no, Some(3));
    assert_eq!(
        decide(&submitted, "rev", verify(2), &observed).unwrap_err(),
        CoreError::SubmissionMismatch
    );
    // Every other command, from every status, leaves it as it was.
    for (name, command) in commands() {
        for status in TaskStatus::ALL {
            let mut before = task(status);
            before.approved_submission_no = Some(7);
            if name == "verify" {
                continue;
            }
            for actor in ["req", "asg", "rev"] {
                if let Ok(decision) = decide(&before, actor, command.clone(), &observed) {
                    assert_eq!(
                        decision.task.approved_submission_no,
                        Some(7),
                        "{name} from {status:?}"
                    );
                }
            }
        }
    }
    // Finished is finished, so nothing can follow an approval.
    for (name, command) in commands() {
        for actor in ["req", "asg", "rev"] {
            assert!(
                decide(&approved, actor, command.clone(), &observed).is_err(),
                "{name}"
            );
        }
    }
}
