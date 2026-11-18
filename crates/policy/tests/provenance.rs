#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

//! M7 step 4 (decision 228, S-29): who reads a task's provenance, and what counts as external.

use podster_core::{decide_create, NewTask, Task};
use podster_policy::provenance::*;
use podster_policy::*;
use PrincipalKind::*;

fn task() -> Task {
    decide_create(
        "agt_lead",
        NewTask {
            id: "t".into(),
            title: "x".into(),
            instructions: "y".into(),
            acceptance_criteria: None,
            assignee: Some("agt_bob".into()),
            reviewer: Some("agt_rev".into()),
            due_at: None,
            follow_up_of: None,
            has_linked_repository: false,
        },
    )
    .unwrap()
    .task
}

fn caller(id: &str, kind: PrincipalKind, role: Role, scopes: Scopes) -> Caller {
    Caller {
        id: id.into(),
        kind,
        role,
        scopes,
    }
}

#[test]
fn exactly_those_who_may_read_the_task_see_its_provenance() {
    let t = task();
    let mut cases = vec![];
    for role in Role::ALL {
        for kind in [Person, Agent] {
            for scopes in [Scopes::GUEST, Scopes::MEMBER, Scopes::COORDINATOR] {
                for id in ["agt_lead", "agt_bob", "agt_rev", "agt_other", "per_x"] {
                    cases.push(caller(id, kind, role, scopes));
                }
            }
        }
    }
    for c in &cases {
        assert_eq!(
            sees_provenance(c, &t),
            authorize_task(c, &t, TaskAction::Read) == Verdict::Allow,
            "{c:?}"
        );
    }
    // Spot checks, so the comparison above isn't vacuous.
    assert!(sees_provenance(
        &caller("agt_bob", Agent, Role::Guest, Scopes::GUEST),
        &t
    ));
    assert!(!sees_provenance(
        &caller("agt_other", Agent, Role::Guest, Scopes::GUEST),
        &t
    ));
    assert!(!sees_provenance(
        &caller("agt_bob", Agent, Role::None, Scopes::GUEST),
        &t
    ));
}

#[test]
fn an_author_is_external_unless_the_reader_shares_a_known_organization() {
    assert!(!is_external(Some("org_a"), "org_a"));
    assert!(is_external(Some("org_b"), "org_a"));
    // Nobody recorded: it counts as external, so run policy treats it as the least trusted.
    assert!(is_external(None, "org_a"));
    // An empty organization matches nothing, even an empty reader's.
    assert!(is_external(Some(""), "org_a"));
    assert!(is_external(Some(""), ""));
}
