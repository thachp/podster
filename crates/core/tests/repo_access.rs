#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use podster_core::repo_access::*;
use podster_core::repo_grants::{Grant, GrantRefusal};
use podster_core::repositories::{GrantAction, LinkStatus, RequestState};
use podster_core::{Task, TaskStatus};

const NOW: i64 = 1_800_000_000_000;
const MINUTE: i64 = 60 * 1000;
const HOUR: i64 = 60 * MINUTE;
const REPO: i64 = 4242;

fn task(status: TaskStatus) -> Task {
    Task {
        id: "t".into(),
        title: "title".into(),
        instructions: "instructions".into(),
        acceptance_criteria: None,
        requester: "req".into(),
        assignee: (status != TaskStatus::Open).then(|| "agent".to_string()),
        reviewer: "rev".into(),
        status,
        version: 5,
        due_at: None,
        follow_up_of: None,
        has_linked_repository: true,
        submission_no: 0,
        submission_commit: None,
        approved_submission_no: None,
        submission_files: 0,
        assignee_departed: false,
        needs_reviewer: false,
        needs_requester: false,
    }
}

fn push(expires_at: Option<i64>, revoked_at: Option<i64>) -> Grant<'static> {
    Grant {
        id: "g1",
        principal: "agent",
        delegated_by: "owner",
        provider_repo_id: REPO,
        action: GrantAction::Push,
        expires_at,
        revoked_at,
    }
}

/// A request that passes every check: the assigned, connected agent of an accepted task in a room whose repository is
/// ready, holding a live push grant, before its deadline.
fn passing<'a>(task: &'a Task, grant: &'a Grant<'a>) -> AccessCheck<'a> {
    AccessCheck {
        task,
        caller: "agent",
        caller_is_agent: true,
        in_room: true,
        connected: true,
        request: Some(RequestState::Ready),
        link: Some(LinkStatus::Ready),
        link_repo_id: Some(REPO),
        grant: Some(grant),
        delegation_holder: Some("owner"),
        deadline: Deadline::At(NOW + HOUR),
        budget: Budget::Remaining,
        held: None,
        now: NOW,
    }
}

#[test]
fn the_assigned_agent_with_a_push_grant_gets_one_repository_and_the_least_it_needs() {
    let (task, grant) = (task(TaskStatus::Accepted), push(None, None));
    assert_eq!(
        decide_access(&passing(&task, &grant)),
        Ok(Access {
            repo_id: REPO,
            permissions: TokenPermissions::AGENT,
            token: TokenPlan::Mint {
                replace_held: false
            },
            authority_ends_at: Some(NOW + HOUR),
        })
    );
    assert_eq!(
        TokenPermissions::AGENT.pairs(),
        [
            ("contents", "write"),
            ("metadata", "read"),
            ("pull_requests", "write")
        ]
    );
    // A task with no deadline says so, and gets a token.
    let open_ended = AccessCheck {
        deadline: Deadline::NoDeadline,
        ..passing(&task, &grant)
    };
    assert_eq!(decide_access(&open_ended).unwrap().authority_ends_at, None);
}

#[test]
fn every_missing_piece_refuses_by_name() {
    let accepted = task(TaskStatus::Accepted);
    let live = push(None, None);
    let base = passing(&accepted, &live);
    let unlinked = Task {
        has_linked_repository: false,
        ..task(TaskStatus::Accepted)
    };
    let someone_elses = Task {
        assignee: Some("other".into()),
        ..task(TaskStatus::Accepted)
    };
    let expired = push(Some(NOW), None);
    let revoked = push(None, Some(NOW - 1));
    let merge_only = Grant {
        action: GrantAction::Merge,
        ..live
    };
    let elsewhere = Grant {
        provider_repo_id: REPO + 1,
        ..live
    };
    use AccessRefusal as R;
    for (name, check, refusal, code) in [
        (
            "a person",
            AccessCheck {
                caller_is_agent: false,
                ..base
            },
            R::NotAllowed,
            "not_allowed",
        ),
        (
            "removed from the room",
            AccessCheck {
                in_room: false,
                ..base
            },
            R::AccessRevoked,
            "access_revoked",
        ),
        (
            "disconnected",
            AccessCheck {
                connected: false,
                ..base
            },
            R::AgentDisconnected,
            "agent_disconnected",
        ),
        (
            "another agent's task",
            AccessCheck {
                task: &someone_elses,
                ..base
            },
            R::NotAllowed,
            "not_allowed",
        ),
        (
            "a task with no repository",
            AccessCheck {
                task: &unlinked,
                ..base
            },
            R::TaskNotLinked,
            "task_not_linked",
        ),
        (
            "a ready link with no repository ID",
            AccessCheck {
                link_repo_id: None,
                ..base
            },
            R::RepoNotReady,
            "repo_not_ready",
        ),
        (
            "the deadline is now",
            AccessCheck {
                deadline: Deadline::At(NOW),
                ..base
            },
            R::DeadlinePassed,
            "deadline_passed",
        ),
        (
            "the deadline passed",
            AccessCheck {
                deadline: Deadline::At(NOW - HOUR),
                ..base
            },
            R::DeadlinePassed,
            "deadline_passed",
        ),
        (
            "no budget left",
            AccessCheck {
                budget: Budget::Exhausted,
                ..base
            },
            R::BudgetExhausted,
            "budget_exhausted",
        ),
        (
            "no grant",
            AccessCheck {
                grant: None,
                ..base
            },
            R::Grant(GrantRefusal::GrantRequired),
            "grant_required",
        ),
        (
            "an expired grant",
            AccessCheck {
                grant: Some(&expired),
                ..base
            },
            R::Grant(GrantRefusal::GrantExpired),
            "grant_expired",
        ),
        (
            "a revoked grant",
            AccessCheck {
                grant: Some(&revoked),
                ..base
            },
            R::Grant(GrantRefusal::GrantRequired),
            "grant_required",
        ),
        // A merge grant never pushes, and a grant on another repository is none (AC-10).
        (
            "a merge grant",
            AccessCheck {
                grant: Some(&merge_only),
                ..base
            },
            R::Grant(GrantRefusal::GrantRequired),
            "grant_required",
        ),
        (
            "a grant on another repository",
            AccessCheck {
                grant: Some(&elsewhere),
                ..base
            },
            R::Grant(GrantRefusal::GrantRequired),
            "grant_required",
        ),
    ] {
        assert_eq!(decide_access(&check), Err(refusal), "{name}");
        assert_eq!(refusal.code(), code, "{name}");
    }
}

#[test]
fn only_an_accepted_task_gets_a_token() {
    let grant = push(None, None);
    for status in TaskStatus::ALL {
        let task = task(status);
        let got = decide_access(&passing(&task, &grant));
        match status {
            TaskStatus::Accepted => assert!(got.is_ok()),
            // An open task has no assignee, so nobody is its agent.
            TaskStatus::Open => assert_eq!(got, Err(AccessRefusal::NotAllowed)),
            TaskStatus::Offered
            | TaskStatus::Submitted
            | TaskStatus::Completed
            | TaskStatus::Canceled => {
                assert_eq!(got, Err(AccessRefusal::TaskNotActive), "{status:?}")
            }
        }
    }
    assert_eq!(AccessRefusal::TaskNotActive.code(), "task_not_active");
}

#[test]
fn only_a_ready_repository_gets_a_token() {
    let (task, grant) = (task(TaskStatus::Accepted), push(None, None));
    for (request, link) in [
        (None, None),
        (Some(RequestState::Pending), None),
        (Some(RequestState::Failed), None),
        (Some(RequestState::Uncertain), None),
        (Some(RequestState::Ready), None),
        (Some(RequestState::Ready), Some(LinkStatus::Degraded)),
        (Some(RequestState::Ready), Some(LinkStatus::Suspended)),
    ] {
        let check = AccessCheck {
            request,
            link,
            ..passing(&task, &grant)
        };
        assert_eq!(
            decide_access(&check),
            Err(AccessRefusal::RepoNotReady),
            "{request:?} {link:?}"
        );
    }
}

/// M5-05: without a grant the answer is a refusal, so nothing is asked of GitHub, whatever else holds.
#[test]
fn m5_05_no_grant_means_no_token_plan_at_all() {
    let task = task(TaskStatus::Accepted);
    let grant = push(None, None);
    for held in [
        None,
        Some(HeldToken {
            expires_at: NOW + HOUR,
            grant_id: "g1",
        }),
    ] {
        let check = AccessCheck {
            grant: None,
            held,
            ..passing(&task, &grant)
        };
        assert_eq!(
            decide_access(&check),
            Err(AccessRefusal::Grant(GrantRefusal::GrantRequired)),
            "{held:?}"
        );
    }
}

/// M5-07 and AC-27: a renewal is the same decision. Once the agent is revoked, the task ends or the deadline passes it
/// is refused, though the room still holds a token with time left.
#[test]
fn m5_07_a_renewal_runs_every_check_again() {
    let accepted = task(TaskStatus::Accepted);
    let live = push(None, None);
    let held = Some(HeldToken {
        expires_at: NOW + 50 * MINUTE,
        grant_id: "g1",
    });
    let renewing = AccessCheck {
        held,
        ..passing(&accepted, &live)
    };
    assert_eq!(
        decide_access(&renewing).unwrap().token,
        TokenPlan::ReuseHeld
    );

    let submitted = task(TaskStatus::Submitted);
    let completed = task(TaskStatus::Completed);
    let canceled = task(TaskStatus::Canceled);
    let released = task(TaskStatus::Open);
    let reassigned = Task {
        assignee: Some("other".into()),
        ..task(TaskStatus::Accepted)
    };
    let revoked = push(None, Some(NOW - 1));
    for (name, check, refusal) in [
        (
            "the agent's room access ended",
            AccessCheck {
                in_room: false,
                ..renewing
            },
            AccessRefusal::AccessRevoked,
        ),
        (
            "the agent was disconnected",
            AccessCheck {
                connected: false,
                ..renewing
            },
            AccessRefusal::AgentDisconnected,
        ),
        (
            "the grant was revoked",
            AccessCheck {
                grant: Some(&revoked),
                ..renewing
            },
            AccessRefusal::Grant(GrantRefusal::GrantRequired),
        ),
        (
            "the task was submitted",
            AccessCheck {
                task: &submitted,
                ..renewing
            },
            AccessRefusal::TaskNotActive,
        ),
        (
            "the task was completed",
            AccessCheck {
                task: &completed,
                ..renewing
            },
            AccessRefusal::TaskNotActive,
        ),
        (
            "the task was canceled",
            AccessCheck {
                task: &canceled,
                ..renewing
            },
            AccessRefusal::TaskNotActive,
        ),
        (
            "the task was released",
            AccessCheck {
                task: &released,
                ..renewing
            },
            AccessRefusal::NotAllowed,
        ),
        (
            "the task went to another agent",
            AccessCheck {
                task: &reassigned,
                ..renewing
            },
            AccessRefusal::NotAllowed,
        ),
        (
            "the deadline passed",
            AccessCheck {
                deadline: Deadline::At(NOW - 1),
                ..renewing
            },
            AccessRefusal::DeadlinePassed,
        ),
        (
            "the budget ran out",
            AccessCheck {
                budget: Budget::Exhausted,
                ..renewing
            },
            AccessRefusal::BudgetExhausted,
        ),
        (
            "the repository was suspended",
            AccessCheck {
                link: Some(LinkStatus::Suspended),
                ..renewing
            },
            AccessRefusal::RepoNotReady,
        ),
    ] {
        assert_eq!(decide_access(&check), Err(refusal), "{name}");
    }
}

#[test]
fn a_renewal_never_moves_the_deadline_or_widens_the_token() {
    let (task, grant) = (task(TaskStatus::Accepted), push(None, None));
    let first = decide_access(&passing(&task, &grant)).unwrap();
    let later = AccessCheck {
        now: NOW + 55 * MINUTE,
        held: Some(HeldToken {
            expires_at: NOW + HOUR,
            grant_id: "g1",
        }),
        ..passing(&task, &grant)
    };
    let renewed = decide_access(&later).unwrap();
    assert_eq!(renewed.authority_ends_at, first.authority_ends_at);
    assert_eq!(renewed.permissions, first.permissions);
    assert_eq!(renewed.repo_id, first.repo_id);
    // The new token may outlive the task's authority, which is why the answer carries both times.
    assert_eq!(renewed.token, TokenPlan::Mint { replace_held: true });
}

#[test]
fn an_agent_has_one_live_token_for_a_task() {
    let (task, grant) = (task(TaskStatus::Accepted), push(None, None));
    for (name, expires_in, expected) in [
        ("just issued", HOUR, TokenPlan::ReuseHeld),
        (
            "a moment before the renewal window",
            TOKEN_RENEW_BEFORE_MS + 1,
            TokenPlan::ReuseHeld,
        ),
        (
            "at the renewal window",
            TOKEN_RENEW_BEFORE_MS,
            TokenPlan::Mint { replace_held: true },
        ),
        (
            "nearly expired",
            MINUTE,
            TokenPlan::Mint { replace_held: true },
        ),
        ("expired", 0, TokenPlan::Mint { replace_held: true }),
        (
            "long expired",
            -HOUR,
            TokenPlan::Mint { replace_held: true },
        ),
    ] {
        let check = AccessCheck {
            held: Some(HeldToken {
                expires_at: NOW + expires_in,
                grant_id: "g1",
            }),
            ..passing(&task, &grant)
        };
        assert_eq!(decide_access(&check).unwrap().token, expected, "{name}");
    }
    assert_eq!(TOKEN_RENEW_BEFORE_MS, 5 * MINUTE);
}

/// A held token is returned only under the grant it was minted for. After a re-grant the row is a new one, so a new
/// token is minted and the old one goes, however long it has left.
#[test]
fn a_token_minted_under_an_earlier_grant_isnt_reused_after_a_re_grant() {
    let task = task(TaskStatus::Accepted);
    let first = push(None, None);
    let regranted = Grant {
        id: "g2",
        ..push(None, None)
    };
    let held = Some(HeldToken {
        expires_at: NOW + 50 * MINUTE,
        grant_id: "g1",
    });
    let same_grant = AccessCheck {
        held,
        ..passing(&task, &first)
    };
    assert_eq!(
        decide_access(&same_grant).unwrap().token,
        TokenPlan::ReuseHeld
    );
    let after_regrant = AccessCheck {
        held,
        ..passing(&task, &regranted)
    };
    assert_eq!(
        decide_access(&after_regrant).unwrap().token,
        TokenPlan::Mint { replace_held: true }
    );
}

/// A room that can't say whether a task has a deadline, or a budget, issues nothing. Having none is a different answer,
/// and has to be said.
#[test]
fn an_unknown_deadline_or_budget_refuses() {
    let (task, grant) = (task(TaskStatus::Accepted), push(None, None));
    let base = passing(&task, &grant);
    for (name, deadline, budget, expected) in [
        (
            "a deadline ahead, budget left",
            Deadline::At(NOW + 1),
            Budget::Remaining,
            Ok(Some(NOW + 1)),
        ),
        (
            "explicitly no deadline",
            Deadline::NoDeadline,
            Budget::Remaining,
            Ok(None),
        ),
        (
            "explicitly no budget",
            Deadline::At(NOW + 1),
            Budget::NoBudget,
            Ok(Some(NOW + 1)),
        ),
        (
            "neither set",
            Deadline::NoDeadline,
            Budget::NoBudget,
            Ok(None),
        ),
        (
            "an unknown deadline",
            Deadline::Unknown,
            Budget::Remaining,
            Err(AccessRefusal::DeadlineUnknown),
        ),
        (
            "an unknown deadline, no budget",
            Deadline::Unknown,
            Budget::NoBudget,
            Err(AccessRefusal::DeadlineUnknown),
        ),
        (
            "an unknown budget",
            Deadline::At(NOW + 1),
            Budget::Unknown,
            Err(AccessRefusal::BudgetUnknown),
        ),
        (
            "an unknown budget, no deadline",
            Deadline::NoDeadline,
            Budget::Unknown,
            Err(AccessRefusal::BudgetUnknown),
        ),
        (
            "a passed deadline, unknown budget",
            Deadline::At(NOW),
            Budget::Unknown,
            Err(AccessRefusal::DeadlinePassed),
        ),
    ] {
        let check = AccessCheck {
            deadline,
            budget,
            // A held token changes nothing: an unknown still refuses a renewal.
            held: Some(HeldToken {
                expires_at: NOW + HOUR,
                grant_id: "g1",
            }),
            ..base
        };
        assert_eq!(
            decide_access(&check).map(|access| access.authority_ends_at),
            expected,
            "{name}"
        );
    }
    assert_eq!(AccessRefusal::DeadlineUnknown.code(), "deadline_unknown");
    assert_eq!(AccessRefusal::BudgetUnknown.code(), "budget_unknown");
}

/// A push grant whose giver no longer holds the delegation gets no token, held or new.
#[test]
fn a_grant_from_a_former_owner_gets_no_token() {
    let (task, grant) = (task(TaskStatus::Accepted), push(None, None));
    for holder in [Some("new-owner"), None] {
        let check = AccessCheck {
            delegation_holder: holder,
            held: Some(HeldToken {
                expires_at: NOW + HOUR,
                grant_id: "g1",
            }),
            ..passing(&task, &grant)
        };
        assert_eq!(
            decide_access(&check),
            Err(AccessRefusal::Grant(GrantRefusal::GrantStale)),
            "{holder:?}"
        );
    }
    assert_eq!(
        AccessRefusal::Grant(GrantRefusal::GrantStale).code(),
        "grant_stale"
    );
}

#[test]
fn githubs_answer_must_be_exactly_what_was_asked_for() {
    let asked = TokenPermissions::AGENT;
    let exact = asked.pairs();
    assert!(minted_token_matches(REPO, &[REPO], &exact, asked));
    let reordered = [exact[2], exact[0], exact[1]];
    assert!(minted_token_matches(REPO, &[REPO], &reordered, asked));
    let wider = [exact[0], exact[1], exact[2], ("administration", "write")];
    let stronger = [exact[0], ("metadata", "write"), exact[2]];
    let swapped = [exact[0], exact[1], ("statuses", "write")];
    for (name, repos, permissions) in [
        ("another repository", &[REPO + 1][..], &exact[..]),
        ("a second repository", &[REPO, REPO + 1][..], &exact[..]),
        ("no repository", &[][..], &exact[..]),
        ("an extra permission", &[REPO][..], &wider[..]),
        ("a stronger permission", &[REPO][..], &stronger[..]),
        ("a different permission", &[REPO][..], &swapped[..]),
        ("a missing permission", &[REPO][..], &exact[..2]),
        ("no permissions", &[REPO][..], &[][..]),
    ] {
        assert!(
            !minted_token_matches(REPO, repos, permissions, asked),
            "{name}"
        );
    }
}
