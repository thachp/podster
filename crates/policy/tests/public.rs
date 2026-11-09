#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::collections::BTreeSet;

use podster_policy::public::*;
use podster_policy::*;

const HANDLE: &str = "pub_0123456789abcdef0123456789abcdef";
const OTHER_HANDLE: &str = "pub_ffffffffffffffffffffffffffffffff";

fn opening(id: &str, preset: Preset, claimable: bool) -> OpeningRow {
    OpeningRow {
        id: id.into(),
        title: format!("{} title", preset.name()),
        responsibilities: format!("{} duties", preset.name()),
        capacity: 2,
        preset,
        is_lead: false,
        publicly_claimable: claimable,
        created_by: "per_owner".into(),
        created_at: 1,
        version: 1,
        closed_at: None,
        active_holders: vec![],
    }
}

fn public_room() -> RoomState {
    RoomState {
        room: RoomRow {
            workspace_id: "ws_room".into(),
            name: "Billing v2".into(),
            goal: Some("Ship billing".into()),
            context: Some("Context".into()),
            brief_by: Some("per_owner".into()),
            owner_org_id: "org_owner".into(),
            owner_person_id: "per_owner".into(),
            policy_version: 3,
            created_at: 1,
            archived: false,
            workflow: Workflow::Engineering,
            topic: Some(Topic::Engineering),
            require_person_review: true,
            visibility: Visibility::Public,
            public_handle: Some(HANDLE.into()),
            published_at: Some(1_794_096_000), // 2026-11-08 UTC
            suspended: false,
            public_claims_paused: false,
        },
        openings: vec![opening("role_pub", Preset::PublicParticipant, true)],
        outputs: vec![OutputRow {
            id: "out_1".into(),
            title: "Spec".into(),
            description: None,
            ready: false,
            created_by: "per_owner".into(),
            removed_at: None,
            current_task_id: None,
            current_submission_no: None,
        }],
        members: vec![MemberRow {
            principal_id: "per_owner".into(),
            kind: PrincipalKind::Person,
            org_id: "org_owner".into(),
            revoked_at: None,
        }],
    }
}

fn anyone() -> RoomPageReader {
    RoomPageReader::Public(PublicCaller::from_public_assertion())
}

fn page(state: &RoomState) -> Option<PublicWorkroomView> {
    room_page(&anyone(), true, state, HANDLE)
}

fn keys(value: &serde_json::Value, path: &str, out: &mut BTreeSet<String>) {
    match value {
        serde_json::Value::Object(map) => {
            for (k, v) in map {
                let p = format!("{path}{k}");
                out.insert(p.clone());
                keys(v, &format!("{p}."), out);
            }
        }
        serde_json::Value::Array(items) => {
            for v in items {
                keys(v, &format!("{path}[]."), out);
            }
        }
        _ => {}
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// The golden test: the exact field set. Changing it means changing decision 146's table and the contract too.

#[test]
fn the_view_has_exactly_the_allowlisted_fields() {
    let mut state = public_room();
    state.room.goal = None;
    state.outputs[0].description = Some("d".into());
    let json: serde_json::Value = serde_json::from_str(&page(&state).unwrap().to_json()).unwrap();
    let mut found = BTreeSet::new();
    keys(&json, "", &mut found);
    let expected: BTreeSet<String> = [
        "content",
        "content.archived",
        "content.context",
        "content.goal",
        "content.name",
        "content.openings",
        "content.openings.[].capacity",
        "content.openings.[].filled",
        "content.openings.[].id",
        "content.openings.[].lead",
        "content.openings.[].preset",
        "content.openings.[].publicly_claimable",
        "content.openings.[].responsibilities",
        "content.openings.[].title",
        "content.outputs",
        "content.outputs.[].description",
        "content.outputs.[].ready",
        "content.outputs.[].title",
        "content.participant_count",
        "content.person_review",
        "content.topic",
        "content.workflow",
        "handle",
        "published_on",
    ]
    .into_iter()
    .map(String::from)
    .collect();
    assert_eq!(found, expected);
}

#[test]
fn the_json_is_canonical() {
    let view = page(&public_room()).unwrap();
    let json = view.to_json();
    let reparsed: serde_json::Value = serde_json::from_str(&json).unwrap();
    // serde_json's default map is sorted, and it writes no whitespace.
    assert_eq!(serde_json::to_string(&reparsed).unwrap(), json);
    assert_eq!(view.published_on, "2026-11-08");
}

#[test]
fn strings_are_escaped() {
    let mut state = public_room();
    state.room.name = "a\"b\\c\n\u{1}<script>é".into();
    let json = page(&state).unwrap().to_json();
    let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed["content"]["name"], "a\"b\\c\n\u{1}<script>é");
    assert!(json.contains("\\u0001"));
}

// ---------------------------------------------------------------------------------------------------------------------
// The canary test: a sentinel in every field that isn't public, including closed openings and removed outputs.

#[test]
fn no_private_value_reaches_the_view() {
    let canary = |n: &str| format!("CANARY_{n}");
    let mut state = public_room();
    let r = &mut state.room;
    r.workspace_id = canary("workspace_id");
    r.brief_by = Some(canary("brief_by"));
    r.owner_org_id = canary("owner_org");
    r.owner_person_id = canary("owner_person");
    r.policy_version = 987_654_321;
    r.created_at = 876_543_219;

    let mut public = opening("role_pub", Preset::PublicParticipant, true);
    public.created_by = canary("opening_created_by");
    public.created_at = 765_432_198;
    public.version = 654_321_987;
    public.active_holders = vec![canary("holder_1"), canary("holder_2")];

    // Shown, but its ID isn't: it can't be claimed publicly.
    let mut invited = opening(&canary("invited_opening_id"), Preset::Guest, false);
    invited.created_by = canary("invited_created_by");
    let mut lead = opening(&canary("lead_opening_id"), Preset::Coordinator, true);
    lead.is_lead = true;
    lead.capacity = 1;
    let member_preset = opening(&canary("member_opening_id"), Preset::Member, true);

    let mut closed = opening(&canary("closed_opening_id"), Preset::Guest, true);
    closed.title = canary("closed_opening_title");
    closed.responsibilities = canary("closed_opening_duties");
    closed.closed_at = Some(5);
    closed.active_holders = vec![canary("closed_holder")];
    state.openings = vec![public, invited, lead, member_preset, closed];

    state.outputs = vec![
        OutputRow {
            id: canary("output_id"),
            title: "Spec".into(),
            description: Some("Shown".into()),
            ready: true,
            created_by: canary("output_created_by"),
            removed_at: None,
            current_task_id: Some(canary("current_task")),
            current_submission_no: Some(543_219_876),
        },
        OutputRow {
            id: canary("removed_output_id"),
            title: canary("removed_output_title"),
            description: Some(canary("removed_output_description")),
            ready: true,
            created_by: canary("removed_output_created_by"),
            removed_at: Some(9),
            current_task_id: Some(canary("removed_output_task")),
            current_submission_no: Some(1),
        },
    ];
    state.members = vec![
        MemberRow {
            principal_id: canary("member_person"),
            kind: PrincipalKind::Person,
            org_id: canary("member_org"),
            revoked_at: None,
        },
        MemberRow {
            principal_id: canary("member_agent"),
            kind: PrincipalKind::Agent,
            org_id: canary("guest_org"),
            revoked_at: None,
        },
        MemberRow {
            principal_id: canary("revoked_agent"),
            kind: PrincipalKind::Agent,
            org_id: canary("revoked_org"),
            revoked_at: Some(3),
        },
    ];

    let view = page(&state).unwrap();
    let json = view.to_json();
    for needle in [
        "CANARY",
        "987654321",
        "876543219",
        "765432198",
        "654321987",
        "543219876",
    ] {
        assert!(!json.contains(needle), "{needle} leaked: {json}");
    }

    // What should be there is.
    let c = &view.content;
    assert_eq!(c.openings.len(), 4);
    let (claimable, rest): (Vec<_>, Vec<_>) = c.openings.iter().partition(|o| o.id.is_some());
    assert_eq!(claimable.len(), 1);
    assert_eq!(claimable[0].id.as_deref(), Some("role_pub"));
    assert_eq!(claimable[0].filled, 2);
    assert!(rest.iter().all(|o| !o.publicly_claimable));
    assert_eq!(rest.iter().filter(|o| o.lead).count(), 1);
    assert_eq!(c.outputs.len(), 1);
    assert_eq!(c.participant_count, 2);
}

// ---------------------------------------------------------------------------------------------------------------------
// Who decides what's public

#[test]
fn only_a_public_room_under_its_current_handle_is_shown() {
    let state = public_room();
    assert!(page(&state).is_some());
    let signed_in = RoomPageReader::SignedIn(SignedInReader {
        id: "agt_x".into(),
        kind: PrincipalKind::Agent,
    });
    assert_eq!(
        room_page(&signed_in, true, &state, HANDLE),
        page(&state),
        "the same view for everyone"
    );

    assert!(room_page(&anyone(), false, &state, HANDLE).is_none());
    assert!(room_page(&anyone(), true, &state, OTHER_HANDLE).is_none());
    assert!(room_page(&anyone(), true, &state, "ws_room").is_none());
    assert!(room_page(&anyone(), true, &state, &HANDLE.to_uppercase()).is_none());
    assert!(room_page(&anyone(), true, &state, &format!(" {HANDLE}")).is_none());

    let mut private = public_room();
    private.room.visibility = Visibility::Private;
    assert!(page(&private).is_none());

    let mut suspended = public_room();
    suspended.room.suspended = true;
    assert!(page(&suspended).is_none());

    let mut no_handle = public_room();
    no_handle.room.public_handle = None;
    assert!(page(&no_handle).is_none());

    let mut no_time = public_room();
    no_time.room.published_at = None;
    assert!(page(&no_time).is_none(), "fails closed");
}

#[test]
fn an_archived_public_room_reads_with_nothing_to_claim() {
    let mut state = public_room();
    state.room.archived = true;
    let view = page(&state).unwrap();
    assert!(view.content.archived);
    assert!(view.content.openings.iter().all(|o| o.id.is_none()));
}

#[test]
fn explore_confirms_with_the_room() {
    let reader = SignedInReader {
        id: "per_x".into(),
        kind: PrincipalKind::Person,
    };
    let state = public_room();
    assert_eq!(explore_entry(&reader, true, &state, HANDLE), page(&state));
    let mut gone = public_room();
    gone.room.visibility = Visibility::Private;
    assert!(explore_entry(&reader, true, &gone, HANDLE).is_none());
}

#[test]
fn handles() {
    assert!(is_public_handle(HANDLE));
    assert!(!is_public_handle("pub_0123456789abcdef0123456789abcde"));
    assert!(!is_public_handle("pub_0123456789abcdef0123456789abcdef0"));
    assert!(!is_public_handle("pub_0123456789ABCDEF0123456789abcdef"));
    assert!(!is_public_handle("pub_0123456789abcdef0123456789abcdeg"));
    assert!(!is_public_handle("ws_0123456789abcdef0123456789abcdef"));
    assert!(!is_public_handle(""));
}

#[test]
fn utc_days() {
    assert_eq!(utc_day(0), "1970-01-01");
    assert_eq!(utc_day(86_399), "1970-01-01");
    assert_eq!(utc_day(-1), "1969-12-31");
    assert_eq!(utc_day(951_782_400), "2000-02-29");
    assert_eq!(utc_day(1_794_182_399), "2026-11-08");
}

// ---------------------------------------------------------------------------------------------------------------------
// Publishing

fn caller(kind: PrincipalKind, role: Role) -> Caller {
    Caller {
        id: "x".into(),
        kind,
        role,
        scopes: Scopes::MEMBER,
    }
}

#[test]
fn only_the_owner_publishes_and_owner_or_admin_unpublishes() {
    use PrincipalKind::*;
    use Visibility::*;
    for (kind, role, public, private) in [
        (Person, Role::Owner, Verdict::Allow, Verdict::Allow),
        (Person, Role::Admin, Verdict::Forbidden, Verdict::Allow),
        (Person, Role::Member, Verdict::Forbidden, Verdict::Forbidden),
        (Person, Role::Guest, Verdict::Forbidden, Verdict::Forbidden),
        (Agent, Role::Owner, Verdict::Forbidden, Verdict::Forbidden),
        (Agent, Role::Admin, Verdict::Forbidden, Verdict::Forbidden),
        (Agent, Role::Member, Verdict::Forbidden, Verdict::Forbidden),
        (
            Person,
            Role::None,
            Verdict::NotParticipant,
            Verdict::NotParticipant,
        ),
    ] {
        assert_eq!(
            authorize_set_visibility(&caller(kind, role), Public),
            public,
            "{kind:?} {role:?}"
        );
        assert_eq!(
            authorize_set_visibility(&caller(kind, role), Private),
            private,
            "{kind:?} {role:?}"
        );
    }
}

fn private_room() -> RoomState {
    let mut s = public_room();
    s.room.visibility = Visibility::Private;
    s.room.public_handle = None;
    s.room.published_at = None;
    s
}

#[test]
fn publishing_names_the_previewed_content() {
    let state = private_room();
    let hash = content_hash(&public_content(&state));
    assert_eq!(hash.len(), 64);
    assert_eq!(
        decide_publish(true, &state, &hash),
        Ok(PublishOutcome::Publish)
    );

    // Anything public changing after the preview stops it.
    let mut edited = private_room();
    edited.room.context = Some("Changed".into());
    assert_eq!(
        decide_publish(true, &edited, &hash),
        Err(PublishRefusal::StalePreview)
    );
    let mut filled = private_room();
    filled.openings[0].active_holders.push("agt_new".into());
    assert_eq!(
        decide_publish(true, &filled, &hash),
        Err(PublishRefusal::StalePreview)
    );

    // Something private changing doesn't.
    let mut internal = private_room();
    internal.room.policy_version += 1;
    internal.openings[0].version += 1;
    assert_eq!(
        decide_publish(true, &internal, &hash),
        Ok(PublishOutcome::Publish)
    );

    assert_eq!(
        decide_publish(false, &state, &hash),
        Err(PublishRefusal::Disabled)
    );
    let mut archived = private_room();
    archived.room.archived = true;
    let archived_hash = content_hash(&public_content(&archived));
    assert_eq!(
        decide_publish(true, &archived, &archived_hash),
        Err(PublishRefusal::Archived)
    );
    let mut suspended = private_room();
    suspended.room.suspended = true;
    assert_eq!(
        decide_publish(true, &suspended, &hash),
        Err(PublishRefusal::Suspended)
    );
    let public = public_room();
    assert_eq!(
        decide_publish(true, &public, &content_hash(&public_content(&public))),
        Ok(PublishOutcome::AlreadyPublic)
    );
}

#[test]
fn the_preview_is_the_served_content() {
    let state = public_room();
    assert_eq!(page(&state).unwrap().content, public_content(&state));
}

#[test]
fn unpublishing() {
    assert_eq!(
        decide_unpublish(&public_room(), false),
        UnpublishOutcome::Unpublish {
            end_public_claims: false
        }
    );
    let mut suspended = public_room();
    suspended.room.suspended = true;
    assert_eq!(
        decide_unpublish(&suspended, true),
        UnpublishOutcome::Unpublish {
            end_public_claims: true
        }
    );
    assert_eq!(
        decide_unpublish(&private_room(), false),
        UnpublishOutcome::AlreadyPrivate
    );
}

// ---------------------------------------------------------------------------------------------------------------------
// Public claims

fn agent() -> PublicClaimant {
    PublicClaimant {
        kind: PrincipalKind::Agent,
        allows_public_claims: true,
        public_claims_suspended: false,
        standing: RoomStanding::Outside,
    }
}

fn claim(
    state: &RoomState,
    opening: &str,
    who: PublicClaimant,
) -> Result<Preset, PublicClaimRefusal> {
    decide_public_claim(true, state, HANDLE, opening, who)
}

#[test]
fn a_public_claim_gets_only_the_openings_preset() {
    let mut state = public_room();
    state
        .openings
        .push(opening("role_guest", Preset::Guest, true));
    assert_eq!(
        claim(&state, "role_pub", agent()),
        Ok(Preset::PublicParticipant)
    );
    assert_eq!(claim(&state, "role_guest", agent()), Ok(Preset::Guest));
}

#[test]
fn only_public_participant_and_guest_openings_and_never_the_lead() {
    use PublicClaimRefusal::*;
    let mut state = public_room();
    let mut lead = opening("role_lead", Preset::Coordinator, true);
    lead.is_lead = true;
    let mut guest_lead = opening("role_guest_lead", Preset::Guest, true);
    guest_lead.is_lead = true;
    let mut closed = opening("role_closed", Preset::Guest, true);
    closed.closed_at = Some(1);
    state.openings.extend([
        lead,
        guest_lead,
        opening("role_member", Preset::Member, true),
        opening("role_coord", Preset::Coordinator, true),
        opening("role_invited", Preset::Guest, false),
        closed,
    ]);
    for id in [
        "role_lead",
        "role_guest_lead",
        "role_member",
        "role_coord",
        "role_invited",
        "role_closed",
        "role_missing",
    ] {
        assert_eq!(claim(&state, id, agent()), Err(OpeningHidden), "{id}");
    }
}

#[test]
fn a_public_claim_needs_a_public_room_and_a_willing_agent() {
    use PublicClaimRefusal::*;
    let state = public_room();
    assert_eq!(
        decide_public_claim(false, &state, HANDLE, "role_pub", agent()),
        Err(RoomHidden)
    );
    assert_eq!(
        decide_public_claim(true, &state, OTHER_HANDLE, "role_pub", agent()),
        Err(RoomHidden)
    );
    assert_eq!(claim(&private_room(), "role_pub", agent()), Err(RoomHidden));

    let mut archived = public_room();
    archived.room.archived = true;
    assert_eq!(claim(&archived, "role_pub", agent()), Err(Archived));
    let mut paused = public_room();
    paused.room.public_claims_paused = true;
    assert_eq!(claim(&paused, "role_pub", agent()), Err(Paused));

    let cases = [
        (
            PublicClaimant {
                kind: PrincipalKind::Person,
                ..agent()
            },
            NotAnAgent,
        ),
        (
            PublicClaimant {
                allows_public_claims: false,
                ..agent()
            },
            PolicyRefuses,
        ),
        (
            PublicClaimant {
                public_claims_suspended: true,
                ..agent()
            },
            OperatorSuspended,
        ),
        (
            PublicClaimant {
                standing: RoomStanding::Member,
                ..agent()
            },
            AlreadyMember,
        ),
        (
            PublicClaimant {
                standing: RoomStanding::Removed,
                ..agent()
            },
            Removed,
        ),
        (
            PublicClaimant {
                standing: RoomStanding::AwaitingOwnerConsent,
                ..agent()
            },
            AwaitingOwnerConsent,
        ),
    ];
    for (who, refusal) in cases {
        assert_eq!(claim(&state, "role_pub", who), Err(refusal));
    }

    let mut full = public_room();
    full.openings[0].active_holders = vec!["a".into(), "b".into()];
    assert_eq!(claim(&full, "role_pub", agent()), Err(Full));
}

#[test]
fn refusal_codes_hide_what_strangers_cant_see() {
    assert_eq!(PublicClaimRefusal::RoomHidden.code(), "workspace_not_found");
    assert_eq!(PublicClaimRefusal::OpeningHidden.code(), "role_not_found");
}

// ---------------------------------------------------------------------------------------------------------------------
// Review fixes

#[test]
fn explore_leaves_out_archived_rooms_that_still_have_a_page() {
    let reader = SignedInReader {
        id: "per_x".into(),
        kind: PrincipalKind::Person,
    };
    let mut archived = public_room();
    archived.room.archived = true;
    assert!(page(&archived).unwrap().content.archived);
    assert!(explore_entry(&reader, true, &archived, HANDLE).is_none());
}

#[test]
fn a_public_room_needs_person_review() {
    let mut state = private_room();
    state.room.require_person_review = false;
    let hash = content_hash(&public_content(&state));
    assert_eq!(
        decide_publish(true, &state, &hash),
        Err(PublishRefusal::PersonReviewOff)
    );
    let mut public = public_room();
    public.room.require_person_review = false;
    assert_eq!(
        claim(&public, "role_pub", agent()),
        Err(PublicClaimRefusal::PersonReviewOff)
    );
}

#[test]
fn row_order_doesnt_change_the_view_or_its_hash() {
    let mut state = public_room();
    let mut later = opening("role_b", Preset::Guest, true);
    later.created_at = 2;
    let mut same_time = opening("role_a", Preset::Guest, false);
    same_time.created_at = 2;
    state.openings.extend([later, same_time]);
    state.outputs.push(OutputRow {
        id: "out_0".into(),
        title: "Plan".into(),
        ..state.outputs[0].clone()
    });
    let mut shuffled = state.clone();
    shuffled.openings.reverse();
    shuffled.outputs.reverse();

    let a = public_content(&state);
    let b = public_content(&shuffled);
    assert_eq!(a, b);
    assert_eq!(content_hash(&a), content_hash(&b));
    let ids: Vec<_> = a.openings.iter().map(|o| o.title.as_str()).collect();
    assert_eq!(
        ids,
        ["public_participant title", "guest title", "guest title"]
    );
    assert_eq!(a.openings[1].id, None, "role_a sorts before role_b");
    assert_eq!(a.openings[2].id.as_deref(), Some("role_b"));
    assert_eq!(a.outputs[0].title, "Plan");
}

// ---------------------------------------------------------------------------------------------------------------------
// Room visibility commands (step 5, pure part)

#[test]
fn a_new_handle_is_a_valid_handle() {
    let handle = public_handle_from([0xab; 16]);
    assert_eq!(handle, format!("pub_{}", "ab".repeat(16)));
    assert!(is_public_handle(&handle));
    assert!(is_public_handle(&public_handle_from([0; 16])));
    assert!(is_public_handle(&public_handle_from([0xff; 16])));
}

#[test]
fn topics_come_from_the_fixed_list() {
    assert_eq!(parse_topic(None), Ok(None));
    assert_eq!(parse_topic(Some("film")), Ok(Some(Topic::Film)));
    assert_eq!(parse_topic(Some("Film")), Err(UnknownTopic));
    assert_eq!(parse_topic(Some("buy-now")), Err(UnknownTopic));
    assert_eq!(parse_topic(Some("")), Err(UnknownTopic));
}

#[test]
fn only_public_participant_and_guest_openings_can_be_marked_claimable() {
    use OpeningSettingRefusal::*;
    for preset in Preset::ALL {
        assert_eq!(check_opening_setting(preset, false, false), Ok(()));
        assert_eq!(check_opening_setting(preset, true, false), Ok(()));
        assert_eq!(
            check_opening_setting(preset, true, true),
            Err(LeadNotPublic)
        );
    }
    assert_eq!(
        check_opening_setting(Preset::PublicParticipant, false, true),
        Ok(())
    );
    assert_eq!(check_opening_setting(Preset::Guest, false, true), Ok(()));
    assert_eq!(
        check_opening_setting(Preset::Member, false, true),
        Err(PresetNotPublic)
    );
    assert_eq!(
        check_opening_setting(Preset::Coordinator, false, true),
        Err(PresetNotPublic)
    );
    assert_eq!(LeadNotPublic.field(), "is_lead");
    assert_eq!(PresetNotPublic.code(), "invalid_argument");
}

#[test]
fn set_visibility_checks_authority_first() {
    let owner = caller(PrincipalKind::Person, Role::Owner);
    let admin = caller(PrincipalKind::Person, Role::Admin);
    let outsider = caller(PrincipalKind::Person, Role::None);
    let agent = caller(PrincipalKind::Agent, Role::Owner);
    let state = private_room();
    let publish = VisibilityRequest::Publish {
        view_hash: content_hash(&public_content(&state)),
    };
    let stale = VisibilityRequest::Publish {
        view_hash: "0".repeat(64),
    };

    assert_eq!(
        decide_set_visibility(&owner, true, &state, &publish),
        Ok(VisibilityChange::Publish)
    );
    // Someone who may not publish gets their refusal, not the stale preview's.
    assert_eq!(
        decide_set_visibility(&admin, true, &state, &stale),
        Err(VisibilityRefusal::Denied(Verdict::Forbidden))
    );
    assert_eq!(
        decide_set_visibility(&outsider, true, &state, &stale),
        Err(VisibilityRefusal::Denied(Verdict::NotParticipant))
    );
    assert_eq!(
        decide_set_visibility(&agent, true, &state, &publish),
        Err(VisibilityRefusal::Denied(Verdict::Forbidden))
    );
    assert_eq!(
        decide_set_visibility(&owner, true, &state, &stale),
        Err(VisibilityRefusal::Publish(PublishRefusal::StalePreview))
    );
    assert_eq!(
        decide_set_visibility(&owner, false, &state, &publish),
        Err(VisibilityRefusal::Publish(PublishRefusal::Disabled))
    );

    let public = public_room();
    let again = VisibilityRequest::Publish {
        view_hash: content_hash(&public_content(&public)),
    };
    assert_eq!(
        decide_set_visibility(&owner, true, &public, &again),
        Ok(VisibilityChange::NoChange)
    );
    let unpublish = VisibilityRequest::Unpublish {
        end_public_claims: true,
    };
    assert_eq!(
        decide_set_visibility(&admin, true, &public, &unpublish),
        Ok(VisibilityChange::Unpublish {
            end_public_claims: true
        })
    );
    // Going private works even with the feature off, since it only reduces exposure.
    assert_eq!(
        decide_set_visibility(&admin, false, &public, &unpublish),
        Ok(VisibilityChange::Unpublish {
            end_public_claims: true
        })
    );
    assert_eq!(
        decide_set_visibility(&admin, true, &state, &unpublish),
        Ok(VisibilityChange::NoChange)
    );
    assert_eq!(
        decide_set_visibility(&agent, true, &public, &unpublish),
        Err(VisibilityRefusal::Denied(Verdict::Forbidden))
    );
}

#[test]
fn visibility_events_and_audit_reasons() {
    use VisibilityChange::*;
    assert_eq!(Publish.event_type(), Some("room.published"));
    assert_eq!(
        Unpublish {
            end_public_claims: false
        }
        .event_type(),
        Some("room.unpublished")
    );
    assert_eq!(NoChange.event_type(), None);
    assert_eq!(Publish.audit_reason(), Some("visibility.published"));
    assert_eq!(
        Unpublish {
            end_public_claims: true
        }
        .audit_reason(),
        Some("visibility.unpublished_claims_ended")
    );
    assert_eq!(NoChange.audit_reason(), None);
}

// ---------------------------------------------------------------------------------------------------------------------
// The participation policy (step 4)

#[test]
fn participation_policy_defaults_to_invitations_only() {
    assert_eq!(
        ParticipationPolicy::default(),
        ParticipationPolicy::InvitationsOnly
    );
    assert!(!ParticipationPolicy::default().allows_public_claims());
    assert!(ParticipationPolicy::PublicClaims.allows_public_claims());
    for p in ParticipationPolicy::ALL {
        assert_eq!(ParticipationPolicy::from_name(p.name()), Some(p));
    }
    assert_eq!(ParticipationPolicy::from_name("PUBLIC_CLAIMS"), None);
    assert_eq!(ParticipationPolicy::from_name(""), None);
}

#[test]
fn only_a_person_administering_the_agents_org_sets_it() {
    assert!(may_set_participation_policy(PrincipalKind::Person, true));
    assert!(!may_set_participation_policy(PrincipalKind::Person, false));
    assert!(!may_set_participation_policy(PrincipalKind::Agent, true));
    assert!(!may_set_participation_policy(PrincipalKind::Agent, false));
}

// ---------------------------------------------------------------------------------------------------------------------
// The discovery index (step 6, pure part)

#[test]
fn a_public_room_is_listed_with_its_keys_only() {
    let mut state = public_room();
    state.room.topic = Some(Topic::Research);
    let row = index_row(&state, Some("pub_old"));
    assert_eq!(
        row,
        PublicIndexRow {
            resolvable: true,
            listed: true,
            public_handle: Some(HANDLE.into()),
            topic: Some(Topic::Research),
            has_open_opening: true,
            published_at: Some(1_794_096_000),
        }
    );
}

#[test]
fn an_open_opening_needs_room_an_unpaused_room_and_a_claimable_setting() {
    let mut full = public_room();
    full.openings[0].active_holders = vec!["a".into(), "b".into()];
    assert!(!index_row(&full, None).has_open_opening);
    let mut paused = public_room();
    paused.room.public_claims_paused = true;
    assert!(!index_row(&paused, None).has_open_opening);
    let mut invited_only = public_room();
    invited_only.openings[0].publicly_claimable = false;
    assert!(!index_row(&invited_only, None).has_open_opening);
    let mut lead = public_room();
    lead.openings[0].is_lead = true;
    assert!(!index_row(&lead, None).has_open_opening);
}

#[test]
fn an_archived_public_room_resolves_but_isnt_listed() {
    let mut archived = public_room();
    archived.room.archived = true;
    archived.room.topic = Some(Topic::Film);
    assert_eq!(
        index_row(&archived, Some("pub_old")),
        PublicIndexRow {
            resolvable: true,
            listed: false,
            public_handle: Some(HANDLE.into()),
            topic: Some(Topic::Film),
            has_open_opening: false,
            published_at: Some(1_794_096_000),
        }
    );
}

#[test]
fn a_private_suspended_or_undated_room_is_a_blank_tombstone() {
    let blank = PublicIndexRow {
        resolvable: false,
        listed: false,
        public_handle: None,
        topic: None,
        has_open_opening: false,
        published_at: None,
    };
    let mut suspended = public_room();
    suspended.room.suspended = true;
    let mut suspended_archived = public_room();
    suspended_archived.room.suspended = true;
    suspended_archived.room.archived = true;
    let mut no_time = public_room();
    no_time.room.published_at = None;
    for state in [private_room(), suspended, suspended_archived, no_time] {
        assert_eq!(index_row(&state, None), blank);
        // A tombstone keeps the last handle it's given, never the room's current one.
        let tombstone = index_row(&state, Some("pub_00000000000000000000000000000001"));
        assert_eq!(
            tombstone,
            PublicIndexRow {
                public_handle: Some("pub_00000000000000000000000000000001".into()),
                ..blank.clone()
            }
        );
    }
}

#[test]
fn publish_refusal_codes_match_the_api() {
    assert_eq!(PublishRefusal::Disabled.code(), "public_rooms_disabled");
    assert_eq!(PublishRefusal::Archived.code(), "workspace_archived");
    assert_eq!(PublishRefusal::Suspended.code(), "room_suspended");
    assert_eq!(PublishRefusal::StalePreview.code(), "version_conflict");
    assert_eq!(
        PublishRefusal::PersonReviewOff.code(),
        "person_review_required"
    );
}

#[test]
fn person_review_stays_on_while_public() {
    assert!(!may_turn_off_person_review(Visibility::Public));
    assert!(may_turn_off_person_review(Visibility::Private));
}
