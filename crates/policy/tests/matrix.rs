#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use podster_core::{Task, TaskStatus};
use podster_policy::*;
use PrincipalKind::*;
use TaskAction as A;

fn task() -> Task {
    Task {
        id: "t".into(),
        title: "x".into(),
        instructions: "y".into(),
        acceptance_criteria: None,
        requester: "req".into(),
        assignee: Some("asg".into()),
        reviewer: "rev".into(),
        status: TaskStatus::Accepted,
        version: 1,
        due_at: None,
        follow_up_of: None,
        has_linked_repository: false,
        submission_no: 0,
        submission_commit: None,
        approved_submission_no: None,
        submission_files: 0,
        assignee_departed: false,
        needs_reviewer: false,
        needs_requester: false,
    }
}

fn caller(id: &str, kind: PrincipalKind, role: Role) -> Caller {
    Caller {
        id: id.into(),
        kind,
        role,
        scopes: Scopes::for_role(role, false),
    }
}

const PARTIES: [&str; 4] = ["req", "asg", "rev", "stranger"];

/// Independent statement of PRODUCT.md and ACCESS-CONTROL.md, for every kind × role × party × action.
fn expected(kind: PrincipalKind, role: Role, party: &str, action: A) -> Verdict {
    if role == Role::None {
        return Verdict::NotParticipant;
    }
    let human_admin = kind == Person && matches!(role, Role::Owner | Role::Admin);
    let is_party = party != "stranger";
    let sees = human_admin || role == Role::Member || is_party;
    if !sees {
        return Verdict::Hidden;
    }
    let allowed = match action {
        A::Read | A::PostMessage => true,
        A::Update | A::Assign | A::SetReviewer | A::Cancel => party == "req" || human_admin,
        A::SetRequester => human_admin,
        A::SetPlan => (party == "req" || human_admin) && (human_admin || role == Role::Member),
        A::Accept | A::Decline | A::Release | A::Submit => party == "asg",
        A::RequestChanges | A::Verify => party == "rev",
    };
    if allowed {
        Verdict::Allow
    } else {
        Verdict::Forbidden
    }
}

#[test]
fn every_kind_role_party_and_action_matches_the_matrix() {
    let mut checked = 0;
    for kind in [Person, Agent] {
        for role in Role::ALL {
            for party in PARTIES {
                for action in A::ALL {
                    for status in TaskStatus::ALL {
                        let task = Task { status, ..task() };
                        let got = authorize_task(&caller(party, kind, role), &task, action);
                        assert_eq!(
                            got,
                            expected(kind, role, party, action),
                            "{kind:?} {role:?} {party} {action:?} {status:?}"
                        );
                        checked += 1;
                    }
                }
            }
        }
    }
    assert_eq!(checked, 2 * 5 * 4 * 14 * 6);
}

#[test]
fn agents_never_hold_admin_authority_even_with_a_stored_role() {
    for role in [Role::Owner, Role::Admin] {
        let agent = caller("stranger", Agent, role);
        assert_eq!(authorize_task(&agent, &task(), A::Read), Verdict::Hidden);
        for action in [
            WorkroomAction::ManageAccess,
            WorkroomAction::AppointAdmin,
            WorkroomAction::ReadAuditLog,
            WorkroomAction::ManageRoom,
            WorkroomAction::PlanRelationship,
            WorkroomAction::SetPlanStart,
            WorkroomAction::CreateTask,
        ] {
            assert_eq!(
                authorize_workroom(&agent, action),
                Verdict::Forbidden,
                "{role:?} {action:?}"
            );
        }
        assert_eq!(
            authorize_task(&caller("req", Agent, role), &task(), A::SetRequester),
            Verdict::Forbidden
        );
    }
}

#[test]
fn only_the_human_owner_appoints_admins() {
    assert_eq!(
        authorize_workroom(
            &caller("x", Person, Role::Owner),
            WorkroomAction::AppointAdmin
        ),
        Verdict::Allow
    );
    for role in [Role::Admin, Role::Member, Role::Guest] {
        assert_eq!(
            authorize_workroom(&caller("x", Person, role), WorkroomAction::AppointAdmin),
            Verdict::Forbidden,
            "{role:?}"
        );
    }
}

#[test]
fn access_management_is_for_human_owners_and_admins() {
    for (role, want) in [
        (Role::Owner, Verdict::Allow),
        (Role::Admin, Verdict::Allow),
        (Role::Member, Verdict::Forbidden),
        (Role::Guest, Verdict::Forbidden),
        (Role::None, Verdict::NotParticipant),
    ] {
        assert_eq!(
            authorize_workroom(&caller("x", Person, role), WorkroomAction::ManageAccess),
            want,
            "{role:?}"
        );
    }
}

#[test]
fn guests_create_tasks_only_when_invited_to() {
    let mut guest = caller("g", Agent, Role::Guest);
    assert_eq!(
        authorize_workroom(&guest, WorkroomAction::CreateTask),
        Verdict::Forbidden
    );
    guest.scopes = Scopes::for_role(Role::Guest, true);
    assert_eq!(
        authorize_workroom(&guest, WorkroomAction::CreateTask),
        Verdict::Allow
    );
    assert_eq!(
        authorize_workroom(
            &caller("m", Agent, Role::Member),
            WorkroomAction::CreateTask
        ),
        Verdict::Allow
    );
}

#[test]
fn guests_cant_learn_about_tasks_theyre_not_party_to() {
    let guest = caller("stranger", Agent, Role::Guest);
    assert!(!can_see_task(&guest, &task()));
    for action in A::ALL {
        assert_eq!(
            authorize_task(&guest, &task(), action),
            Verdict::Hidden,
            "{action:?}"
        );
    }
}

#[test]
fn an_assignee_who_is_also_the_reviewer_cant_sign_off() {
    let same = Task {
        reviewer: "asg".into(),
        ..task()
    };
    for role in [Role::Owner, Role::Admin, Role::Member, Role::Guest] {
        let actor = caller("asg", Person, role);
        assert_eq!(
            authorize_task(&actor, &same, A::Verify),
            Verdict::Forbidden,
            "{role:?}"
        );
        assert_eq!(
            authorize_task(&actor, &same, A::RequestChanges),
            Verdict::Forbidden,
            "{role:?}"
        );
    }
}

#[test]
fn a_requester_cant_swap_the_reviewer_of_a_submitted_task() {
    let submitted = Task {
        status: TaskStatus::Submitted,
        ..task()
    };
    assert_eq!(
        authorize_reviewer_change(&caller("req", Agent, Role::Member), &submitted),
        Verdict::Forbidden
    );
    assert_eq!(
        authorize_reviewer_change(&caller("req", Agent, Role::Member), &task()),
        Verdict::Allow
    );
    assert_eq!(
        authorize_reviewer_change(&caller("a", Person, Role::Admin), &submitted),
        Verdict::Allow
    );
}

#[test]
fn reviewers_must_be_current_and_meet_the_room_policy() {
    assert!(can_review(Agent, Role::Member, Scopes::MEMBER, false));
    assert!(!can_review(Agent, Role::Member, Scopes::MEMBER, true));
    assert!(can_review(Person, Role::Guest, Scopes::GUEST, true));
    assert!(!can_review(Person, Role::None, Scopes::GUEST, false));
    // A participant whose scope has no review can't be named, and a human admin always can be.
    assert!(!can_review(
        Agent,
        Role::Guest,
        Scopes::PUBLIC_PARTICIPANT,
        false
    ));
    assert!(can_review(
        Person,
        Role::Admin,
        Scopes::PUBLIC_PARTICIPANT,
        false
    ));
}

#[test]
fn a_revoked_caller_is_refused_everywhere() {
    for party in PARTIES {
        for action in A::ALL {
            assert_eq!(
                authorize_task(&caller(party, Person, Role::None), &task(), action),
                Verdict::NotParticipant
            );
        }
    }
}

#[test]
fn leaving_an_organization_ends_only_what_began_by_then_in_that_organization() {
    assert!(org_departure_ends("org_a", "org_a", 5, 10));
    assert!(org_departure_ends("org_a", "org_a", 10, 10));
    assert!(!org_departure_ends("org_a", "org_a", 11, 10));
    assert!(!org_departure_ends("org_b", "org_a", 5, 10));
}

#[test]
fn only_human_owners_and_admins_rename_or_archive_a_room() {
    for (role, verdict) in [
        (Role::Owner, Verdict::Allow),
        (Role::Admin, Verdict::Allow),
        (Role::Member, Verdict::Forbidden),
        (Role::Guest, Verdict::Forbidden),
        (Role::None, Verdict::NotParticipant),
    ] {
        assert_eq!(
            authorize_workroom(&caller("x", Person, role), WorkroomAction::ManageRoom),
            verdict,
            "{role:?}"
        );
    }
}

#[test]
fn a_denied_change_is_named_only_from_a_fixed_list() {
    assert_eq!(
        denied_change_name("POST", &["tasks", "t_1", "accept"]),
        Some("task.accept")
    );
    assert_eq!(
        denied_change_name("DELETE", &["organizations", "org_a"]),
        Some("organization.revoke")
    );
    assert_eq!(
        denied_change_name("POST", &["tasks", "t_1", "<script>"]),
        None
    );
    assert_eq!(denied_change_name("GET", &["tasks"]), None);
    assert_eq!(denied_change_name("POST", &["anything"]), None);
}

#[test]
fn only_a_lack_of_authority_counts_as_a_denial() {
    for code in [
        "not_allowed",
        "access_revoked",
        "workspace_not_found",
        "self_sign_off",
    ] {
        assert!(is_authority_refusal("task.accept", code), "{code}");
    }
    for code in [
        "invalid_argument",
        "version_conflict",
        "idempotency_mismatch",
        "workspace_archived",
        "internal_error",
        "not_in_organization",
        "not_found",
    ] {
        assert!(!is_authority_refusal("task.accept", code), "{code}");
    }
    assert!(is_authority_refusal("member.withdraw", "not_found"));
    assert!(is_authority_refusal("member.owner_consent", "not_found"));
}

#[test]
fn owner_authority_ends_when_the_owner_left_or_rejoined() {
    assert!(owner_authority_holds(None, Some(10), Some(10)));
    assert!(owner_authority_holds(None, Some(10), Some(5)));
    assert!(!owner_authority_holds(None, Some(10), Some(11)));
    assert!(!owner_authority_holds(Some(20), Some(10), Some(10)));
    assert!(!owner_authority_holds(Some(20), Some(10), None));
    // With nothing to compare, a recorded departure still counts, and a room with no start refuses a known membership.
    assert!(owner_authority_holds(None, Some(10), None));
    assert!(!owner_authority_holds(None, None, Some(1)));
}

#[test]
fn only_an_organizations_admin_who_is_a_person_can_recover() {
    assert!(may_recover_ownership(Person, true));
    assert!(!may_recover_ownership(Person, false));
    assert!(!may_recover_ownership(Agent, true));
}

#[test]
fn only_the_owner_who_is_a_person_can_transfer() {
    let caller = |kind, role| Caller {
        id: "x".into(),
        kind,
        role,
        scopes: Scopes::for_role(role, false),
    };
    let allowed = |kind, role| {
        authorize_workroom(&caller(kind, role), WorkroomAction::TransferOwner) == Verdict::Allow
    };
    assert!(allowed(Person, Role::Owner));
    assert!(!allowed(Agent, Role::Owner));
    assert!(!allowed(Person, Role::Admin));
    assert!(!allowed(Person, Role::Member));
    assert!(!allowed(Person, Role::Guest));
}

#[test]
fn ownership_changes_are_named_in_the_denial_record() {
    assert_eq!(
        denied_change_name("POST", &["owner", "transfer"]),
        Some("owner.transfer")
    );
    assert_eq!(
        denied_change_name("POST", &["owner", "recover"]),
        Some("owner.recover")
    );
}

/// Every value of every scope, so a test can ask about anything an owner or admin could set.
fn every_scopes() -> Vec<Scopes> {
    let mut all = Vec::new();
    for tasks in TaskScope::ALL {
        for artifacts in ArtifactScope::ALL {
            for conversations in ConversationScope::ALL {
                for review in ReviewScope::ALL {
                    all.push(Scopes {
                        tasks,
                        artifacts,
                        conversations,
                        review,
                    });
                }
            }
        }
    }
    all
}

#[test]
fn the_four_presets_match_the_product_table() {
    let row = |preset: &str| Preset::from_name(preset).unwrap().scopes();
    let names = |s: Scopes| {
        (
            s.tasks.name(),
            s.artifacts.name(),
            s.conversations.name(),
            s.review.name(),
        )
    };
    assert_eq!(
        names(row("public_participant")),
        ("own", "shared", "own", "none")
    );
    assert_eq!(names(row("guest")), ("own", "own", "own", "when_named"));
    assert_eq!(
        names(row("member")),
        ("all_create", "all", "all", "when_named")
    );
    assert_eq!(
        names(row("coordinator")),
        ("coordinate", "all", "all", "when_named")
    );
    assert_eq!(Preset::from_name("admin"), None);
    assert_eq!(Preset::from_name("owner"), None);
    for preset in Preset::ALL {
        assert_eq!(preset.scopes().preset(), Some(preset));
        assert_ne!(preset.role_name(), "admin");
    }
}

#[test]
fn kernel_roles_map_onto_presets_with_nothing_changed() {
    assert_eq!(
        Scopes::for_role(Role::Member, false).preset(),
        Some(Preset::Member)
    );
    assert_eq!(
        Scopes::for_role(Role::Guest, false).preset(),
        Some(Preset::Guest)
    );
    // A guest's switch only adds creating.
    let creating = Scopes::for_role(Role::Guest, true);
    assert_eq!(
        creating,
        Scopes {
            tasks: TaskScope::OwnCreate,
            ..Scopes::GUEST
        }
    );
    assert_eq!(creating.preset(), None);
    // The stored switch means nothing for a member, as before.
    assert_eq!(Scopes::for_role(Role::Member, true), Scopes::MEMBER);
}

#[test]
fn no_scope_gives_any_administration() {
    for kind in [Person, Agent] {
        for role in [Role::Member, Role::Guest] {
            for scopes in every_scopes() {
                let who = Caller {
                    scopes,
                    ..caller("x", kind, role)
                };
                for action in [
                    WorkroomAction::ManageAccess,
                    WorkroomAction::AppointAdmin,
                    WorkroomAction::ReadAuditLog,
                    WorkroomAction::ManageRoom,
                    WorkroomAction::TransferOwner,
                ] {
                    assert_eq!(
                        authorize_workroom(&who, action),
                        Verdict::Forbidden,
                        "{scopes:?} {action:?}"
                    );
                }
                assert_ne!(
                    authorize_task(&who, &task(), A::SetRequester),
                    Verdict::Allow
                );
            }
        }
    }
}

#[test]
fn a_stored_grant_neither_lifts_an_agent_nor_limits_a_human_admin() {
    let narrow = Caller {
        scopes: Scopes::PUBLIC_PARTICIPANT,
        ..caller("stranger", Person, Role::Admin)
    };
    assert_eq!(authorize_task(&narrow, &task(), A::Read), Verdict::Allow);
    assert_eq!(
        authorize_workroom(&narrow, WorkroomAction::CreateTask),
        Verdict::Allow
    );
    let wide = Caller {
        scopes: Scopes::COORDINATOR,
        ..caller("stranger", Agent, Role::Admin)
    };
    assert_eq!(authorize_task(&wide, &task(), A::Read), Verdict::Hidden);
    assert_eq!(
        authorize_workroom(&wide, WorkroomAction::CreateTask),
        Verdict::Forbidden
    );
    let outsider = Caller {
        scopes: Scopes::COORDINATOR,
        ..caller("req", Person, Role::None)
    };
    assert!(!can_see_task(&outsider, &task()));
    assert!(!sees_whole_room(&outsider));
}

#[test]
fn task_scope_decides_what_is_seen_and_created_whatever_the_role() {
    let with = |id: &str, tasks| Caller {
        scopes: Scopes {
            tasks,
            ..Scopes::GUEST
        },
        ..caller(id, Agent, Role::Member)
    };
    assert_eq!(
        authorize_task(&with("stranger", TaskScope::Own), &task(), A::Read),
        Verdict::Hidden
    );
    assert_eq!(
        authorize_task(&with("stranger", TaskScope::OwnCreate), &task(), A::Read),
        Verdict::Hidden
    );
    assert_eq!(
        authorize_task(&with("req", TaskScope::Own), &task(), A::Read),
        Verdict::Allow
    );
    for scope in [TaskScope::All, TaskScope::AllCreate, TaskScope::Coordinate] {
        assert_eq!(
            authorize_task(&with("stranger", scope), &task(), A::Read),
            Verdict::Allow
        );
    }
    let creates =
        |scope| authorize_workroom(&with("x", scope), WorkroomAction::CreateTask) == Verdict::Allow;
    assert!(!creates(TaskScope::Own));
    assert!(creates(TaskScope::OwnCreate));
    assert!(!creates(TaskScope::All));
    assert!(creates(TaskScope::AllCreate));
    assert!(creates(TaskScope::Coordinate));
}

#[test]
fn the_coordinator_takes_over_only_a_task_whose_requester_left_and_only_for_itself() {
    let lead = Caller {
        scopes: Scopes::COORDINATOR,
        ..caller("stranger", Agent, Role::Member)
    };
    let orphan = Task {
        needs_requester: true,
        ..task()
    };
    assert_eq!(
        authorize_requester_change(&lead, &orphan, "stranger", false),
        Verdict::Allow
    );
    assert_eq!(
        authorize_requester_change(&lead, &orphan, "someone_else", false),
        Verdict::Forbidden
    );
    assert_eq!(
        authorize_requester_change(&lead, &task(), "stranger", false),
        Verdict::Forbidden
    );
    // The flag can outlast a requester coming back, and then it's theirs again.
    assert_eq!(
        authorize_requester_change(&lead, &orphan, "stranger", true),
        Verdict::Forbidden
    );
    // It's the scope, not any other, and the plain action stays with owners and admins.
    assert_eq!(
        authorize_task(&lead, &orphan, A::SetRequester),
        Verdict::Forbidden
    );
    for scope in [
        TaskScope::Own,
        TaskScope::OwnCreate,
        TaskScope::All,
        TaskScope::AllCreate,
    ] {
        let other = Caller {
            scopes: Scopes {
                tasks: scope,
                ..Scopes::MEMBER
            },
            ..caller("req", Agent, Role::Member)
        };
        assert_ne!(
            authorize_requester_change(&other, &orphan, "req", false),
            Verdict::Allow,
            "{scope:?}"
        );
    }
    let admin = caller("x", Person, Role::Admin);
    assert_eq!(
        authorize_requester_change(&admin, &task(), "anyone", true),
        Verdict::Allow
    );
    let agent_admin = Caller {
        scopes: Scopes::COORDINATOR,
        ..caller("req", Agent, Role::Admin)
    };
    assert_ne!(
        authorize_requester_change(&agent_admin, &orphan, "req", false),
        Verdict::Allow
    );
    let outsider = Caller {
        scopes: Scopes::COORDINATOR,
        ..caller("x", Agent, Role::None)
    };
    assert_eq!(
        authorize_requester_change(&outsider, &orphan, "x", false),
        Verdict::NotParticipant
    );
    // A hidden task stays hidden, however the request is formed.
    let guest = caller("stranger", Agent, Role::Guest);
    assert_eq!(
        authorize_requester_change(&guest, &orphan, "", false),
        Verdict::Hidden
    );
}

#[test]
fn only_agents_claim_roles() {
    assert!(may_claim_role(Agent));
    assert!(!may_claim_role(Person));
}

#[test]
fn ending_a_claim_restores_what_was_had_and_otherwise_never_widens() {
    // Nobody touched it meanwhile: back to what it had, up or down.
    assert_eq!(
        scopes_after_claim(Scopes::GUEST, Scopes::COORDINATOR, true),
        Scopes::GUEST
    );
    assert_eq!(
        scopes_after_claim(Scopes::MEMBER, Scopes::PUBLIC_PARTICIPANT, true),
        Scopes::MEMBER
    );
    // The room set it, even to the same values: the narrower, whichever way it moved.
    assert_eq!(
        scopes_after_claim(Scopes::MEMBER, Scopes::GUEST, false),
        Scopes::GUEST
    );
    let adjusted = Scopes {
        conversations: ConversationScope::Own,
        ..Scopes::COORDINATOR
    };
    assert_eq!(
        scopes_after_claim(Scopes::MEMBER, adjusted, false),
        Scopes {
            conversations: ConversationScope::Own,
            ..Scopes::MEMBER
        }
    );
    assert_eq!(
        scopes_after_claim(Scopes::GUEST, Scopes::COORDINATOR, false),
        Scopes::GUEST
    );
    for prior in every_scopes() {
        for current in every_scopes() {
            assert_eq!(
                scopes_after_claim(prior, current, false),
                prior.narrower(current)
            );
        }
    }
}

#[test]
fn role_changes_are_named_in_the_denial_record() {
    for (method, route, name) in [
        ("POST", vec!["roles"], "role.create"),
        ("PUT", vec!["roles", "r"], "role.update"),
        ("DELETE", vec!["roles", "r"], "role.close"),
        ("POST", vec!["roles", "r", "invites"], "role.invite"),
        (
            "DELETE",
            vec!["roles", "r", "invites", "a"],
            "role.withdraw_invite",
        ),
        ("POST", vec!["roles", "r", "claim"], "role.claim"),
        ("POST", vec!["roles", "r", "release"], "role.release"),
        (
            "DELETE",
            vec!["roles", "r", "claims", "a"],
            "role.end_claim",
        ),
    ] {
        assert_eq!(denied_change_name(method, &route), Some(name));
    }
}

#[test]
fn a_narrow_conversation_scope_hides_threads_on_others_tasks_only() {
    let reader = |id: &str| Caller {
        scopes: Scopes {
            conversations: ConversationScope::Own,
            ..Scopes::MEMBER
        },
        ..caller(id, Agent, Role::Member)
    };
    assert_eq!(
        authorize_task(&reader("stranger"), &task(), A::Read),
        Verdict::Allow
    );
    assert_eq!(
        authorize_task(&reader("stranger"), &task(), A::PostMessage),
        Verdict::Forbidden
    );
    assert!(!task_view(&reader("stranger"), &task()).conversation);
    assert_eq!(
        authorize_task(&reader("asg"), &task(), A::PostMessage),
        Verdict::Allow
    );
    assert!(task_view(&reader("asg"), &task()).conversation);
}

#[test]
fn artifact_scope_decides_which_submissions_can_be_read() {
    let view = |id: &str, artifacts| {
        let who = Caller {
            scopes: Scopes {
                artifacts,
                ..Scopes::MEMBER
            },
            ..caller(id, Agent, Role::Member)
        };
        task_view(&who, &task()).artifacts
    };
    assert_eq!(view("stranger", ArtifactScope::All), ArtifactView::All);
    assert_eq!(
        view("stranger", ArtifactScope::Own),
        ArtifactView::OwnSubmissions
    );
    assert_eq!(view("req", ArtifactScope::Own), ArtifactView::All);
    // Public participant: only what it submitted, even on its own tasks, until anything can be shared.
    assert_eq!(
        view("req", ArtifactScope::Shared),
        ArtifactView::OwnSubmissions
    );
    assert_eq!(
        view("asg", ArtifactScope::Shared),
        ArtifactView::OwnSubmissions
    );
    // Everyone assigned can still submit.
    for artifacts in ArtifactScope::ALL {
        let who = Caller {
            scopes: Scopes {
                artifacts,
                ..Scopes::GUEST
            },
            ..caller("asg", Agent, Role::Guest)
        };
        assert_eq!(authorize_task(&who, &task(), A::Submit), Verdict::Allow);
    }
}

#[test]
fn only_a_review_scope_lets_a_named_reviewer_decide() {
    let reviewer = |review| Caller {
        scopes: Scopes {
            review,
            ..Scopes::GUEST
        },
        ..caller("rev", Agent, Role::Guest)
    };
    assert_eq!(
        authorize_task(&reviewer(ReviewScope::WhenNamed), &task(), A::Verify),
        Verdict::Allow
    );
    assert_eq!(
        authorize_task(&reviewer(ReviewScope::None), &task(), A::Verify),
        Verdict::Forbidden
    );
    assert_eq!(
        authorize_task(&reviewer(ReviewScope::None), &task(), A::RequestChanges),
        Verdict::Forbidden
    );
    assert_eq!(
        authorize_task(&reviewer(ReviewScope::None), &task(), A::Read),
        Verdict::Allow
    );
}

#[test]
fn oversight_is_never_more_than_the_agent_sees() {
    for scopes in every_scopes() {
        let seen = scopes.for_oversight();
        assert!(!seen.tasks.sees_all());
        assert!(!seen.tasks.can_create());
        assert_eq!(seen.conversations, ConversationScope::Own);
        assert_eq!(seen.review, ReviewScope::None);
        if scopes.artifacts == ArtifactScope::Shared {
            assert_eq!(seen.artifacts, ArtifactScope::Shared);
        } else {
            assert_eq!(seen.artifacts, ArtifactScope::Own);
        }
    }
}

#[test]
fn access_and_brief_changes_are_named_in_the_denial_record() {
    assert_eq!(
        denied_change_name("PUT", &["members", "agt_x", "access"]),
        Some("member.change_access")
    );
    assert_eq!(
        denied_change_name("PUT", &["brief"]),
        Some("room.change_brief")
    );
}

#[test]
fn nobody_reviews_work_they_cant_read() {
    let unread = Scopes {
        artifacts: ArtifactScope::Shared,
        ..Scopes::GUEST
    };
    assert!(!unread.is_grantable());
    assert!(!unread.reviews());
    for preset in Preset::ALL {
        assert!(preset.scopes().is_grantable(), "{preset:?}");
    }
    assert!(!can_review(Agent, Role::Guest, unread, false));
    let reviewer = Caller {
        scopes: unread,
        ..caller("rev", Agent, Role::Guest)
    };
    assert_eq!(
        authorize_task(&reviewer, &task(), A::Verify),
        Verdict::Forbidden
    );
    assert_eq!(
        authorize_task(&reviewer, &task(), A::RequestChanges),
        Verdict::Forbidden
    );
    let own = Caller {
        scopes: Scopes::GUEST,
        ..caller("rev", Agent, Role::Guest)
    };
    assert_eq!(authorize_task(&own, &task(), A::Verify), Verdict::Allow);
}

#[test]
fn the_narrower_of_two_grants_never_exceeds_either() {
    let rank = |s: Scopes| {
        (
            u8::from(s.tasks.sees_all()),
            u8::from(s.tasks.can_create()),
            match s.artifacts {
                ArtifactScope::Shared => 0,
                ArtifactScope::Own => 1,
                ArtifactScope::All => 2,
            },
            u8::from(s.conversations == ConversationScope::All),
            u8::from(s.review == ReviewScope::WhenNamed),
        )
    };
    let all = every_scopes();
    for a in &all {
        for b in &all {
            let least = a.narrower(*b);
            assert_eq!(least, b.narrower(*a), "{a:?} {b:?}");
            let (l, x, y) = (rank(least), rank(*a), rank(*b));
            assert!(
                l.0 <= x.0.min(y.0)
                    && l.1 <= x.1.min(y.1)
                    && l.2 <= x.2.min(y.2)
                    && l.3 <= x.3.min(y.3)
                    && l.4 <= x.4.min(y.4),
                "{a:?} {b:?}"
            );
            assert_eq!(a.narrower(*a), *a);
        }
    }
    assert_eq!(
        Scopes::PUBLIC_PARTICIPANT.narrower(Scopes::MEMBER),
        Scopes::PUBLIC_PARTICIPANT
    );
    assert_eq!(Scopes::COORDINATOR.narrower(Scopes::GUEST), Scopes::GUEST);
    assert_eq!(Scopes::COORDINATOR.narrower(Scopes::MEMBER), Scopes::MEMBER);
}

#[test]
fn a_room_requiring_a_person_refuses_agents_at_naming_and_at_the_decision() {
    assert!(!can_review(Agent, Role::Member, Scopes::MEMBER, true));
    assert!(can_review(Person, Role::Guest, Scopes::GUEST, true));
    assert!(can_review(
        Person,
        Role::Admin,
        Scopes::PUBLIC_PARTICIPANT,
        true
    ));
    assert!(!can_review(
        Person,
        Role::Guest,
        Scopes::PUBLIC_PARTICIPANT,
        true
    ));
    assert!(may_decide_review(Agent, false));
    assert!(may_decide_review(Person, false));
    assert!(!may_decide_review(Agent, true));
    assert!(may_decide_review(Person, true));
}

#[test]
fn activity_follows_the_task_and_the_member_list() {
    let with = |id: &str, kind, role, scopes| Caller {
        scopes,
        ..caller(id, kind, role)
    };
    let guest = with("stranger", Agent, Role::Guest, Scopes::GUEST);
    let party = with("asg", Agent, Role::Guest, Scopes::GUEST);
    let member = with("stranger", Agent, Role::Member, Scopes::MEMBER);
    let admin = with("stranger", Person, Role::Admin, Scopes::PUBLIC_PARTICIPANT);
    let outsider = with("asg", Agent, Role::None, Scopes::MEMBER);
    let hidden = task();
    assert!(!can_see_event(
        &guest,
        "task.offered",
        "req",
        Some(&hidden),
        None
    ));
    // Having done something on a task doesn't keep it visible once it's no longer theirs.
    assert!(!can_see_event(
        &guest,
        "task.accepted",
        "stranger",
        Some(&hidden),
        None
    ));
    assert!(can_see_event(
        &party,
        "task.offered",
        "req",
        Some(&hidden),
        None
    ));
    assert!(can_see_event(
        &member,
        "task.offered",
        "req",
        Some(&hidden),
        None
    ));
    assert!(can_see_event(
        &admin,
        "task.offered",
        "req",
        Some(&hidden),
        None
    ));
    assert!(!can_see_event(
        &outsider,
        "task.offered",
        "req",
        Some(&hidden),
        None
    ));
    for kind in EVENTS_FOR_EVERYONE {
        assert!(can_see_event(&guest, kind, "owner", None, None), "{kind}");
        assert!(
            !can_see_event(&outsider, kind, "owner", None, None),
            "{kind}"
        );
    }
    for kind in [
        "member.added",
        "member.revoked",
        "member.role_changed",
        "member.access_changed",
        "role.invited",
        "role.claimed",
        "role.claim_ended",
        "owner.transferred",
        "something.new",
    ] {
        assert!(!can_see_event(&guest, kind, "owner", None, None), "{kind}");
        assert!(can_see_event(&member, kind, "owner", None, None), "{kind}");
        assert!(can_see_event(&admin, kind, "owner", None, None), "{kind}");
        assert!(
            !can_see_event(&outsider, kind, "owner", None, None),
            "{kind}"
        );
    }
    assert!(can_see_event(
        &guest,
        "role.claimed",
        "stranger",
        None,
        None
    ));
}

#[test]
fn the_review_policy_is_named_in_the_denial_record() {
    assert_eq!(
        denied_change_name("PUT", &["review-policy"]),
        Some("room.change_review_policy")
    );
}

#[test]
fn only_a_conversation_scope_for_all_reads_every_thread() {
    let with = |conversations| Caller {
        scopes: Scopes {
            conversations,
            ..Scopes::MEMBER
        },
        ..caller("x", Agent, Role::Member)
    };
    assert!(reads_every_thread(&with(ConversationScope::All)));
    assert!(!reads_every_thread(&with(ConversationScope::Own)));
    assert!(reads_every_thread(&caller("x", Person, Role::Admin)));
    assert!(!reads_every_thread(&Caller {
        scopes: Scopes::MEMBER,
        ..caller("x", Agent, Role::Admin)
    }));
    assert!(!reads_every_thread(&Caller {
        scopes: Scopes::MEMBER,
        ..caller("x", Agent, Role::None)
    }));
}

#[test]
fn only_people_who_run_the_room_plan_relationships() {
    for (kind, role, want) in [
        (Person, Role::Owner, Verdict::Allow),
        (Person, Role::Admin, Verdict::Allow),
        (Person, Role::Member, Verdict::Forbidden),
        (Person, Role::Guest, Verdict::Forbidden),
        (Person, Role::None, Verdict::NotParticipant),
        (Agent, Role::Owner, Verdict::Forbidden),
        (Agent, Role::Admin, Verdict::Forbidden),
        (Agent, Role::Member, Verdict::Forbidden),
        (Agent, Role::Guest, Verdict::Forbidden),
        (Agent, Role::None, Verdict::NotParticipant),
    ] {
        assert_eq!(
            authorize_workroom(&caller("x", kind, role), WorkroomAction::PlanRelationship),
            want,
            "{kind:?} {role:?}"
        );
    }
    assert_eq!(
        denied_change_name("POST", &["collaboration", "planned"]),
        Some("relationship.plan")
    );
    assert_eq!(
        denied_change_name("DELETE", &["collaboration", "planned", "rel_1"]),
        Some("relationship.remove")
    );
    assert_eq!(denied_change_name("GET", &["collaboration"]), None);
}

#[test]
fn planned_lines_reach_everyone_in_the_room_but_only_some_learn_who_set_them() {
    for (kind, role, sees, names) in [
        (Person, Role::Owner, true, true),
        (Person, Role::Admin, true, true),
        (Person, Role::Member, true, true),
        (Agent, Role::Member, true, true),
        (Person, Role::Guest, true, false),
        (Agent, Role::Guest, true, false),
        (Agent, Role::Admin, true, false),
        (Agent, Role::Owner, true, false),
        (Person, Role::None, false, false),
        (Agent, Role::None, false, false),
    ] {
        let who = caller("x", kind, role);
        assert_eq!(sees_planned_relationships(&who), sees, "{kind:?} {role:?}");
        assert_eq!(sees_who_planned(&who), names, "{kind:?} {role:?}");
    }
    let mut narrowed = caller("x", Agent, Role::Member);
    narrowed.scopes.tasks = TaskScope::Own;
    assert!(sees_planned_relationships(&narrowed));
    assert!(!sees_who_planned(&narrowed));
    assert!(!can_see_event(
        &caller("x", Agent, Role::Guest),
        "relationship.planned",
        "per_owner",
        None,
        None
    ));
}

#[test]
fn a_plan_is_for_the_requester_or_a_human_admin_who_sees_the_whole_room() {
    let t = task();
    let plan = |c: &Caller| authorize_task(c, &t, TaskAction::SetPlan);
    let member = |id: &str, role, scope| {
        let mut c = caller(id, PrincipalKind::Agent, role);
        c.scopes.tasks = scope;
        c
    };
    // The requester, with the whole room in view.
    assert_eq!(
        plan(&member(&t.requester, Role::Member, TaskScope::All)),
        Verdict::Allow
    );
    // The same requester limited to its own tasks: refusing a loop could reveal a hidden link.
    assert_eq!(
        plan(&member(&t.requester, Role::Guest, TaskScope::OwnCreate)),
        Verdict::Forbidden
    );
    // Seeing everything and being a coordinator isn't authority over someone else's task.
    assert_eq!(
        plan(&member("agt_other", Role::Member, TaskScope::Coordinate)),
        Verdict::Forbidden
    );
    // An assignee and a reviewer have no say, even with the whole room in view.
    let assignee = t.assignee.clone().unwrap();
    assert_eq!(
        plan(&member(&assignee, Role::Member, TaskScope::All)),
        Verdict::Forbidden
    );
    assert_eq!(
        plan(&member(&t.reviewer, Role::Member, TaskScope::All)),
        Verdict::Forbidden
    );
    // A human admin can, and an agent stored as an admin can't.
    assert_eq!(
        plan(&caller("per_admin", PrincipalKind::Person, Role::Admin)),
        Verdict::Allow
    );
    assert_eq!(
        plan(&caller("per_owner", PrincipalKind::Person, Role::Owner)),
        Verdict::Allow
    );
    assert_eq!(
        plan(&caller("agt_admin", PrincipalKind::Agent, Role::Admin)),
        Verdict::Hidden
    );
    // Nobody outside the room learns the task exists.
    assert_eq!(
        plan(&caller("agt_out", PrincipalKind::Agent, Role::None)),
        Verdict::NotParticipant
    );
}

#[test]
fn only_someone_who_sees_the_whole_room_gets_a_whole_plan() {
    let with = |scope| {
        let mut c = caller("agt_x", PrincipalKind::Agent, Role::Member);
        c.scopes.tasks = scope;
        sees_whole_plan(&c)
    };
    assert!(with(TaskScope::All));
    assert!(with(TaskScope::AllCreate));
    assert!(with(TaskScope::Coordinate));
    assert!(!with(TaskScope::Own));
    assert!(!with(TaskScope::OwnCreate));
    assert!(sees_whole_plan(&caller(
        "per_a",
        PrincipalKind::Person,
        Role::Admin
    )));
    assert!(!sees_whole_plan(&caller(
        "agt_out",
        PrincipalKind::Agent,
        Role::None
    )));
}

#[test]
fn a_plan_edit_shows_only_to_someone_who_sees_the_whole_room() {
    let t = task();
    let mut party = caller(&t.reviewer, PrincipalKind::Agent, Role::Guest);
    party.scopes.tasks = TaskScope::Own;
    assert!(can_see_event(
        &party,
        "task.updated",
        "agt_x",
        Some(&t),
        None
    ));
    assert!(!can_see_event(
        &party,
        TASK_PLAN_CHANGED,
        "agt_x",
        Some(&t),
        None
    ));
    party.scopes.tasks = TaskScope::All;
    assert!(can_see_event(
        &party,
        TASK_PLAN_CHANGED,
        "agt_x",
        Some(&t),
        None
    ));
}

#[test]
fn an_agent_limited_to_its_own_tasks_sees_notices_about_itself_and_nobody_elses() {
    let mut guest = caller("agt_me", PrincipalKind::Agent, Role::Guest);
    guest.scopes.tasks = TaskScope::Own;
    for kind in NOTICES_ABOUT_SUBJECT {
        assert!(
            can_see_event(&guest, kind, "owner", None, Some("agt_me")),
            "{kind}"
        );
        assert!(
            !can_see_event(&guest, kind, "owner", None, Some("agt_other")),
            "{kind}"
        );
        // An old event names nobody, so it stays hidden.
        assert!(!can_see_event(&guest, kind, "owner", None, None), "{kind}");
    }
    // Only these kinds, whoever they're about.
    for kind in [
        "member.revoked",
        "member.role_changed",
        "member.access_changed",
        "role.claimed",
        "owner.transferred",
        "something.new",
    ] {
        assert!(
            !can_see_event(&guest, kind, "owner", None, Some("agt_me")),
            "{kind}"
        );
    }
    // The ruling is about agents.
    let mut person = caller("per_me", PrincipalKind::Person, Role::Guest);
    person.scopes.tasks = TaskScope::Own;
    assert!(!can_see_event(
        &person,
        "member.added",
        "owner",
        None,
        Some("per_me")
    ));
    // Someone outside the room gets nothing, even with their own ID on it.
    let outsider = caller("agt_me", PrincipalKind::Agent, Role::None);
    assert!(!can_see_event(
        &outsider,
        "member.added",
        "owner",
        None,
        Some("agt_me")
    ));
}

#[test]
fn only_a_person_who_runs_the_room_sets_the_plan_start() {
    for (kind, role, allowed) in [
        (Person, Role::Owner, true),
        (Person, Role::Admin, true),
        (Person, Role::Member, false),
        (Person, Role::Guest, false),
        (Agent, Role::Owner, false),
        (Agent, Role::Admin, false),
        (Agent, Role::Member, false),
        (Agent, Role::Guest, false),
    ] {
        let verdict = authorize_workroom(&caller("x", kind, role), WorkroomAction::SetPlanStart);
        assert_eq!(verdict == Verdict::Allow, allowed, "{kind:?} {role:?}");
    }
    assert_eq!(
        authorize_workroom(
            &caller("x", Person, Role::None),
            WorkroomAction::SetPlanStart
        ),
        Verdict::NotParticipant
    );
}

#[test]
fn a_forecast_goes_only_to_someone_who_sees_the_whole_plan_and_never_to_a_guest() {
    let with = |kind, role, tasks| Caller {
        scopes: Scopes {
            tasks,
            ..Scopes::GUEST
        },
        ..caller("x", kind, role)
    };
    assert!(sees_plan_forecast(&caller("x", Person, Role::Owner)));
    assert!(sees_plan_forecast(&caller("x", Person, Role::Admin)));
    assert!(sees_plan_forecast(&with(
        Agent,
        Role::Member,
        TaskScope::All
    )));
    assert!(sees_plan_forecast(&with(
        Person,
        Role::Member,
        TaskScope::All
    )));
    assert!(!sees_plan_forecast(&with(
        Agent,
        Role::Member,
        TaskScope::Own
    )));
    assert!(!sees_plan_forecast(&with(
        Person,
        Role::Member,
        TaskScope::Own
    )));
    assert!(
        !sees_plan_forecast(&with(Person, Role::Guest, TaskScope::All)),
        "widened or not, a guest gets none"
    );
    assert!(!sees_plan_forecast(&with(
        Agent,
        Role::Guest,
        TaskScope::All
    )));
    assert!(
        !sees_plan_forecast(&with(Agent, Role::Admin, TaskScope::All)),
        "an agent stored as an admin counts as a guest"
    );
    assert!(!sees_plan_forecast(&with(
        Person,
        Role::None,
        TaskScope::All
    )));
}
