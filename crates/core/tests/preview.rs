#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]
//! Previews (M8 step 4; the preview plan's sections 3 and 5.6, ADR 0010's revision on previews, decisions 250 to 259):
//! the environment, the deployment's preview switch, the preview slot's own serve state with replacement that keeps the
//! last working preview, what deletes a preview, and the access epoch.

use podster_core::preview::*;
use podster_core::release::{
    unpublish, CommitLiveRefusal, CommitMark, DesiredServe, ReleaseState, ServeState,
    StaleCompletion, UnpublishTrigger,
};

const NOW: i64 = 1_800_000_000_000;
const LABEL: &str = "pv7q2";
const OTHER_LABEL: &str = "k3v9q2";
const ID_A: &str = "rel_0000000000000000000000000000000a";
const ID_B: &str = "rel_0000000000000000000000000000000b";
const ID_C: &str = "rel_0000000000000000000000000000000c";

const SLOT: &str = "pvw_0123456789abcdef0123456789abcdef";
const OTHER_SLOT: &str = "pvw_fedcba9876543210fedcba9876543210";

/// The room's slot holding `serve`, at access epoch `epoch`.
fn slot_of(epoch: u64, serve: PreviewServe) -> PreviewSlot {
    PreviewSlot::from_stored(SLOT, LABEL, epoch, serve).unwrap()
}

/// A preview release committed live on the room's slot holding `serve`: the slot's serve state after, and the mark.
fn commit(
    serve: &PreviewServe,
    release_epoch: u64,
    script: &str,
    release_id: &str,
    state: ReleaseState,
) -> Result<(PreviewServe, CommitMark), PreviewCommitRefusal> {
    let slot = slot_of(0, serve.clone());
    preview_commit_live(&slot, release_epoch, script, release_id, state)
        .map(|(after, mark)| (after.serve().clone(), mark))
}

fn script(label: &str, id: &str) -> String {
    format!("{label}.{id}")
}

/// A small generator with a fixed seed, so the cases below are the same every run.
fn next(state: &mut u64) -> u64 {
    *state = state
        .wrapping_mul(6_364_136_223_846_793_005)
        .wrapping_add(1_442_695_040_888_963_407);
    *state >> 33
}

// --- the environment ---------------------------------------------------------------------------------------------------

#[test]
fn there_are_exactly_two_environments_named_production_and_preview() {
    assert_eq!(
        Environment::ALL,
        [Environment::Production, Environment::Preview]
    );
    for env in Environment::ALL {
        assert_eq!(Environment::parse(env.name()), Some(env));
    }
    assert_eq!(Environment::Production.name(), "production");
    assert_eq!(Environment::Preview.name(), "preview");
    for other in [
        "",
        "Production",
        "PREVIEW",
        "preview ",
        " production",
        "staging",
        "prod",
        "preview:",
    ] {
        assert_eq!(Environment::parse(other), None, "{other:?}");
    }
}

#[test]
fn a_release_with_no_environment_row_is_production_and_an_unknown_row_is_refused() {
    // Workspace step 59: no row means production, so every existing release stays production.
    assert_eq!(recorded_environment(None), Some(Environment::Production));
    assert_eq!(
        recorded_environment(Some("production")),
        Some(Environment::Production)
    );
    assert_eq!(
        recorded_environment(Some("preview")),
        Some(Environment::Preview)
    );
    // A row naming anything else is a fault, read as neither: never silently production, never preview.
    for other in ["", "Preview", "prod", "staging", "preview "] {
        assert_eq!(recorded_environment(Some(other)), None, "{other:?}");
    }
}

#[test]
fn an_upload_binds_only_its_own_environments_store() {
    for release in Environment::ALL {
        for store in Environment::ALL {
            let result = store_belongs(release, store);
            if release == store {
                assert_eq!(result, Ok(()));
            } else {
                assert_eq!(result, Err(StoreEnvironmentMismatch));
                assert_eq!(
                    StoreEnvironmentMismatch.code(),
                    "store_environment_mismatch"
                );
            }
        }
    }
}

// --- the deployment's preview switch -----------------------------------------------------------------------------------

#[test]
fn previews_are_on_only_for_exactly_true_and_deleted_only_for_exactly_false() {
    assert_eq!(deployment_previews(Some("true")), DeploymentPreviews::On);
    assert_eq!(deployment_previews(Some("false")), DeploymentPreviews::Off);
    assert!(DeploymentPreviews::On.allows_previews());
    assert!(!DeploymentPreviews::On.deletes_previews());
    assert!(!DeploymentPreviews::Off.allows_previews());
    assert!(DeploymentPreviews::Off.deletes_previews());
    for other in [
        None,
        Some(""),
        Some("True"),
        Some("TRUE"),
        Some("1"),
        Some("yes"),
        Some("true "),
        Some(" false"),
        Some("False"),
        Some("0"),
    ] {
        let read = deployment_previews(other);
        assert_eq!(read, DeploymentPreviews::Undecided, "{other:?}");
        assert!(!read.allows_previews(), "{other:?}");
        assert!(!read.deletes_previews(), "{other:?}");
    }
}

// --- the preview slot's serve state ------------------------------------------------------------------------------------

#[test]
fn a_new_slot_serves_nothing_on_its_one_default_host() {
    let serve = PreviewServe::new();
    assert_eq!(serve.epoch(), 0);
    assert_eq!(serve.hosts().len(), 1);
    assert_eq!(serve.hosts()[0].script, None);
    assert!(!serve.hosts()[0].closed);
    assert!(serve.in_flight().is_none());
    assert_eq!(serve.serving(), None);
}

#[test]
fn a_stored_slot_holds_a_default_host_and_at_most_one_custom_host() {
    let host = |script: Option<&str>| DesiredServe {
        script: script.map(str::to_owned),
        version: 3,
        closed: false,
    };
    assert!(PreviewServe::from_stored(1, vec![], None).is_none());
    assert!(PreviewServe::from_stored(1, vec![host(None)], None).is_some());
    assert!(PreviewServe::from_stored(1, vec![host(None), host(None)], None).is_some());
    assert!(PreviewServe::from_stored(1, vec![host(None); 3], None).is_none());
    assert_eq!(MAX_PREVIEW_HOSTS, 2);
    // The default host never closes.
    let closed = DesiredServe {
        closed: true,
        ..host(None)
    };
    assert!(PreviewServe::from_stored(1, vec![closed.clone()], None).is_none());
    assert!(PreviewServe::from_stored(1, vec![host(None), closed], None).is_some());
}

/// A slot whose preview `id` is served: committed, then confirmed.
fn serving(id: &str) -> PreviewServe {
    let serve = PreviewServe::new();
    let s = script(LABEL, id);
    let (serve, mark) = commit(&serve, 0, &s, id, ReleaseState::Uploading).unwrap();
    preview_confirm_served(&serve, &mark, &s).unwrap().serve
}

#[test]
fn the_first_preview_goes_live_on_commit_and_is_served_once_its_marker_comes_back() {
    let serve = PreviewServe::new();
    let a = script(LABEL, ID_A);
    let (live, mark) = commit(&serve, 0, &a, ID_A, ReleaseState::Uploading).unwrap();
    assert_eq!(live.hosts()[0].script.as_deref(), Some(a.as_str()));
    assert!(live.in_flight().is_some());
    // Nothing is confirmed until the marker comes back.
    assert_eq!(live.serving(), None);
    let confirmed = preview_confirm_served(&live, &mark, &a).unwrap();
    assert_eq!(confirmed.serve.serving().as_deref(), Some(a.as_str()));
    assert!(confirmed.serve.in_flight().is_none());
    assert!(confirmed.delete.is_empty());
}

#[test]
fn a_replacement_that_is_served_deletes_the_one_it_replaced_and_keeps_nothing_for_a_rollback() {
    let serve = serving(ID_A);
    let a = script(LABEL, ID_A);
    let b = script(LABEL, ID_B);
    let (live, mark) = commit(&serve, 0, &b, ID_B, ReleaseState::Uploading).unwrap();
    let confirmed = preview_confirm_served(&live, &mark, &b).unwrap();
    assert_eq!(confirmed.serve.serving().as_deref(), Some(b.as_str()));
    // No preview rollback (the plan's 3.1, kept scripts): the one before is deleted, never kept.
    assert_eq!(confirmed.delete, vec![a]);
}

#[test]
fn a_failed_replacement_leaves_the_last_working_preview_serving() {
    let serve = serving(ID_A);
    let a = script(LABEL, ID_A);
    let b = script(LABEL, ID_B);
    let (live, mark) = commit(&serve, 0, &b, ID_B, ReleaseState::Uploading).unwrap();
    let back = preview_set_back(&live, &mark, &b).unwrap();
    assert_eq!(back.serve.hosts()[0].script.as_deref(), Some(a.as_str()));
    assert_eq!(back.serve.serving().as_deref(), Some(a.as_str()));
    assert!(back.serve.in_flight().is_none());
    assert!(back.delete_script);
    assert_eq!(back.reverted, vec![0]);
}

#[test]
fn a_second_replacement_while_one_is_in_flight_is_refused_preview_in_flight() {
    let serve = serving(ID_A);
    let b = script(LABEL, ID_B);
    let c = script(LABEL, ID_C);
    let (live, _) = commit(&serve, 0, &b, ID_B, ReleaseState::Uploading).unwrap();
    let refused = commit(&live, 0, &c, ID_C, ReleaseState::Uploading).unwrap_err();
    assert_eq!(
        refused,
        PreviewCommitRefusal::Commit(CommitLiveRefusal::InFlight)
    );
    assert_eq!(refused.code(), "preview_in_flight");
}

#[test]
fn a_retried_commit_of_the_flight_replays_its_answer() {
    let serve = PreviewServe::new();
    let a = script(LABEL, ID_A);
    let first = commit(&serve, 0, &a, ID_A, ReleaseState::Uploading).unwrap();
    let again = commit(&first.0, 0, &a, ID_A, ReleaseState::Live).unwrap();
    assert_eq!(first, again);
}

#[test]
fn a_slot_serves_only_scripts_under_its_own_label_for_their_own_release() {
    let serve = PreviewServe::new();
    // Another room's label, or production's label of this room: never.
    let foreign = script(OTHER_LABEL, ID_A);
    assert_eq!(
        commit(&serve, 0, &foreign, ID_A, ReleaseState::Uploading),
        Err(PreviewCommitRefusal::ScriptMismatch)
    );
    // A script of this label but another release's ID.
    let other_release = script(LABEL, ID_B);
    assert_eq!(
        commit(&serve, 0, &other_release, ID_A, ReleaseState::Uploading),
        Err(PreviewCommitRefusal::ScriptMismatch)
    );
    assert_eq!(
        PreviewCommitRefusal::ScriptMismatch.code(),
        "preview_script_mismatch"
    );
    // Not a script name at all, and a slot label that isn't a label.
    for bad in [
        "",
        "stopped",
        "pv7q2",
        "code:pv7q2.rel_0000000000000000000000000000000a",
    ] {
        assert_eq!(
            commit(&serve, 0, bad, ID_A, ReleaseState::Uploading),
            Err(PreviewCommitRefusal::ScriptMismatch),
            "{bad:?}"
        );
    }
    // A slot whose label isn't a label can't be made at all, so it never serves anything.
    assert!(PreviewSlot::from_stored(SLOT, "PV7Q2", 0, serve.clone()).is_none());
}

#[test]
fn an_ended_or_unready_preview_release_never_goes_live() {
    let serve = PreviewServe::new();
    let a = script(LABEL, ID_A);
    for state in ReleaseState::ALL {
        let result = commit(&serve, 0, &a, ID_A, state);
        if state == ReleaseState::Uploading {
            assert!(result.is_ok());
        } else {
            assert!(
                matches!(result, Err(PreviewCommitRefusal::Commit(_))),
                "{state:?}"
            );
        }
    }
}

#[test]
fn a_stale_completion_changes_nothing() {
    let serve = serving(ID_A);
    let b = script(LABEL, ID_B);
    let (live, mark) = commit(&serve, 0, &b, ID_B, ReleaseState::Uploading).unwrap();
    let a = script(LABEL, ID_A);
    assert_eq!(
        preview_confirm_served(&live, &mark, &a).unwrap_err(),
        StaleCompletion
    );
    assert_eq!(
        preview_set_back(&live, &mark, &a).unwrap_err(),
        StaleCompletion
    );
    // After the confirm, the same confirm again is stale too.
    let done = preview_confirm_served(&live, &mark, &b).unwrap().serve;
    assert_eq!(
        preview_confirm_served(&done, &mark, &b).unwrap_err(),
        StaleCompletion
    );
}

#[test]
fn a_custom_preview_host_opens_on_the_confirmed_preview_and_clears_alone() {
    let a = script(LABEL, ID_A);
    let serve = serving(ID_A);
    let with_custom = serve.with_custom_host().unwrap();
    assert_eq!(with_custom.hosts().len(), 2);
    assert!(with_custom.hosts()[1].closed);
    assert!(
        with_custom.with_custom_host().is_none(),
        "one custom host at most"
    );
    let opened = preview_open_host(&with_custom, 1).unwrap();
    assert_eq!(opened.hosts()[1].script.as_deref(), Some(a.as_str()));
    assert!(!opened.hosts()[1].closed);
    assert!(
        preview_open_host(&opened, 0).is_none(),
        "the default host never opens"
    );
    let cleared = preview_clear_host(&opened, 1).unwrap();
    assert_eq!(cleared.hosts()[1].script, None);
    assert!(cleared.hosts()[1].closed);
    assert_eq!(cleared.hosts()[0].script.as_deref(), Some(a.as_str()));
    assert!(
        preview_clear_host(&opened, 0).is_none(),
        "the default host never clears"
    );
    assert!(preview_clear_host(&opened, 2).is_none());
}

// --- deleting a preview ------------------------------------------------------------------------------------------------

#[test]
fn deleting_a_preview_serves_nothing_raises_both_epochs_deletes_its_scripts_and_retires_its_label()
{
    let a = script(LABEL, ID_A);
    let b = script(LABEL, ID_B);
    let serve = serving(ID_A);
    let (live, _) = commit(&serve, 0, &b, ID_B, ReleaseState::Uploading).unwrap();
    let slot = slot_of(4, live);
    let deletion = delete_preview(&slot);
    assert!(deletion.serve.hosts().iter().all(|h| h.script.is_none()));
    assert!(deletion.serve.in_flight().is_none());
    assert_eq!(deletion.serve.epoch(), 1);
    assert_eq!(deletion.access_epoch, 5);
    assert_eq!(deletion.delete_scripts, vec![a, b]);
    assert_eq!(deletion.retire_label, LABEL);
}

#[test]
fn deleting_a_preview_whose_access_epoch_is_spent_still_takes_everything_down() {
    let slot = slot_of(MAX_ACCESS_EPOCH, serving(ID_A));
    let deletion = delete_preview(&slot);
    assert_eq!(deletion.access_epoch, MAX_ACCESS_EPOCH);
    assert!(deletion.serve.hosts().iter().all(|h| h.script.is_none()));
}

#[test]
fn a_commit_that_started_before_a_deletion_never_goes_live_after_it() {
    let b = script(LABEL, ID_B);
    let slot = slot_of(0, serving(ID_A));
    let deleted = delete_preview(&slot).serve;
    assert_eq!(
        commit(&deleted, 0, &b, ID_B, ReleaseState::Uploading),
        Err(PreviewCommitRefusal::Commit(CommitLiveRefusal::EpochMoved))
    );
}

#[test]
fn every_unpublish_trigger_but_the_room_changing_visibility_deletes_the_preview() {
    for trigger in UnpublishTrigger::ALL {
        let deletes = preview_delete_trigger(trigger);
        if trigger == UnpublishTrigger::RoomMadePrivate {
            assert_eq!(deletes, None, "visibility raises the epoch instead");
        } else {
            assert_eq!(deletes, Some(PreviewDeleteTrigger::Unpublish(trigger)));
            assert_eq!(
                deletes.map(PreviewDeleteTrigger::code),
                Some(trigger.code())
            );
        }
    }
    assert_eq!(
        PreviewDeleteTrigger::PreviewsOffForDeployment.code(),
        "previews_off"
    );
    assert_eq!(PreviewDeleteTrigger::Requested.code(), "preview_deleted");
}

#[test]
fn the_room_changing_visibility_raises_the_access_epoch() {
    assert!(EpochRaise::ALL.contains(&EpochRaise::VisibilityChanged));
}

// --- asking for a preview ----------------------------------------------------------------------------------------------

#[test]
fn a_request_creates_with_no_slot_and_replaces_with_one() {
    assert_eq!(
        preview_request(SlotStatus::None, &[], &[], NOW),
        Ok(PreviewRequestPlan::Create)
    );
    assert_eq!(
        preview_request(SlotStatus::Active, &[ReleaseState::Served], &[], NOW),
        Ok(PreviewRequestPlan::Replace)
    );
}

#[test]
fn a_request_while_any_preview_release_is_in_flight_or_the_slot_is_deleting_is_refused() {
    for state in ReleaseState::ALL {
        let result = preview_request(SlotStatus::Active, &[ReleaseState::Served, state], &[], NOW);
        let in_flight = matches!(
            state,
            ReleaseState::Queued
                | ReleaseState::Uploading
                | ReleaseState::Uncertain
                | ReleaseState::Live
        );
        assert_eq!(attempt_in_flight(state), in_flight, "{state:?}");
        if in_flight {
            assert_eq!(result, Err(PreviewRequestRefusal::InFlight), "{state:?}");
        } else {
            assert_eq!(result, Ok(PreviewRequestPlan::Replace), "{state:?}");
        }
    }
    assert_eq!(
        preview_request(SlotStatus::Deleting, &[], &[], NOW),
        Err(PreviewRequestRefusal::InFlight)
    );
    assert_eq!(PreviewRequestRefusal::InFlight.code(), "preview_in_flight");
}

#[test]
fn previews_share_the_rooms_twenty_asks_a_day_with_releases() {
    let day = podster_core::release::RELEASE_WINDOW_MS;
    let nineteen: Vec<i64> = (0..19).map(|i| NOW - i).collect();
    assert_eq!(
        preview_request(SlotStatus::Active, &[], &nineteen, NOW),
        Ok(PreviewRequestPlan::Replace)
    );
    let twenty: Vec<i64> = (0..20).map(|i| NOW - i).collect();
    assert_eq!(
        preview_request(SlotStatus::Active, &[], &twenty, NOW),
        Err(PreviewRequestRefusal::Limit)
    );
    assert_eq!(PreviewRequestRefusal::Limit.code(), "preview_limit");
    // An ask a full day old no longer counts.
    let mut aged = twenty.clone();
    aged[0] = NOW - day;
    assert_eq!(
        preview_request(SlotStatus::Active, &[], &aged, NOW),
        Ok(PreviewRequestPlan::Replace)
    );
    // In flight is answered before the limit, as the contract orders them.
    assert_eq!(
        preview_request(SlotStatus::Active, &[ReleaseState::Queued], &twenty, NOW),
        Err(PreviewRequestRefusal::InFlight)
    );
}

// --- the access epoch --------------------------------------------------------------------------------------------------

#[test]
fn the_access_epoch_goes_up_by_one_and_stops_at_the_largest_exact_value() {
    assert_eq!(raise_access_epoch(0), Ok(1));
    assert_eq!(raise_access_epoch(41), Ok(42));
    assert_eq!(MAX_ACCESS_EPOCH, 999_999_999_999_999);
    assert_eq!(
        raise_access_epoch(MAX_ACCESS_EPOCH - 1),
        Ok(MAX_ACCESS_EPOCH)
    );
    assert_eq!(raise_access_epoch(MAX_ACCESS_EPOCH), Err(EpochExhausted));
    assert_eq!(raise_access_epoch(u64::MAX), Err(EpochExhausted));
    assert_eq!(EpochExhausted.code(), "preview_epoch_exhausted");
}

#[test]
fn a_token_is_honoured_only_at_or_above_the_epoch_its_host_entry_holds() {
    assert!(epoch_honoured(5, 5));
    assert!(epoch_honoured(6, 5));
    assert!(!epoch_honoured(4, 5));
    assert!(!epoch_honoured(0, 1));
    assert!(epoch_honoured(0, 0));
}

#[test]
fn every_change_that_can_shrink_who_may_view_has_a_named_raise() {
    let codes: Vec<&str> = EpochRaise::ALL.iter().map(|r| r.code()).collect();
    assert_eq!(
        codes,
        [
            "participant_removed",
            "role_lowered",
            "owner_changed",
            "visibility_changed",
            "person_invitation_revoked",
            "preview_deleted",
            "operator_suspension",
            "organization_departure",
        ]
    );
}

// --- properties --------------------------------------------------------------------------------------------------------

/// One step a random walk takes on a slot.
#[derive(Clone, Copy, Debug)]
enum Step {
    Commit(usize),
    Confirm,
    SetBack,
    AddCustom,
    OpenCustom,
    ClearCustom,
    Delete,
}

const IDS: [&str; 6] = [
    "rel_00000000000000000000000000000001",
    "rel_00000000000000000000000000000002",
    "rel_00000000000000000000000000000003",
    "rel_00000000000000000000000000000004",
    "rel_00000000000000000000000000000005",
    "rel_00000000000000000000000000000006",
];

/// Thousands of random walks over the slot's commands. After every step, whatever happened: every script a host names
/// is under the slot's own label; at most one flight is open; the epoch never goes down; nothing is ever kept for a
/// rollback; and a set-back leaves every open host on the preview confirmed before the flight began.
#[test]
fn property_random_walks_keep_the_slot_under_its_own_label_with_the_last_working_preview_on_failure(
) {
    let mut seed = 0x5eed_0004_u64;
    let production_label = "prodlabel";
    // How often each outcome was reached, so the walk is shown not to be vacuous.
    let (mut confirms, mut set_backs, mut refused_labels, mut opened) = (0, 0, 0, 0);
    for _walk in 0..2_000 {
        let mut serve = PreviewServe::new();
        let mut mark = None;
        let mut flight_script = None;
        let mut epoch_seen = 0;
        for _ in 0..30 {
            let step = match next(&mut seed) % 8 {
                0 | 1 => Step::Commit((next(&mut seed) % 6) as usize),
                2 => Step::Confirm,
                3 => Step::SetBack,
                4 => Step::AddCustom,
                5 => Step::OpenCustom,
                6 => Step::ClearCustom,
                _ if next(&mut seed).is_multiple_of(4) => Step::Delete,
                _ => Step::Confirm,
            };
            let confirmed_before = serve.serving();
            match step {
                Step::Commit(i) => {
                    let id = IDS[i];
                    // Half the time, try to slip production's label in: it must always be refused.
                    let label = if next(&mut seed).is_multiple_of(2) {
                        LABEL
                    } else {
                        production_label
                    };
                    let s = script(label, id);
                    match commit(&serve, serve.epoch(), &s, id, ReleaseState::Uploading) {
                        Ok((next_serve, m)) => {
                            assert_eq!(label, LABEL);
                            if mark.is_none() {
                                mark = Some(m);
                                flight_script = Some(s);
                            }
                            serve = next_serve;
                        }
                        Err(PreviewCommitRefusal::ScriptMismatch) => {
                            assert_ne!(label, LABEL);
                            refused_labels += 1;
                        }
                        Err(PreviewCommitRefusal::Commit(_)) => {}
                    }
                }
                Step::Confirm => {
                    if let (Some(m), Some(s)) = (&mark, &flight_script) {
                        if let Ok(done) = preview_confirm_served(&serve, m, s) {
                            // What it deletes is never what it now serves.
                            for gone in &done.delete {
                                assert!(done
                                    .serve
                                    .hosts()
                                    .iter()
                                    .all(|h| h.script.as_ref() != Some(gone)));
                            }
                            serve = done.serve;
                            assert_eq!(serve.serving().as_ref(), Some(s));
                            confirms += 1;
                        }
                        mark = None;
                        flight_script = None;
                    }
                }
                Step::SetBack => {
                    if let (Some(m), Some(s)) = (&mark, &flight_script) {
                        if let Ok(back) = preview_set_back(&serve, m, s) {
                            serve = back.serve;
                            set_backs += 1;
                            // The last working preview is what every open host serves again.
                            for host in serve.hosts().iter().filter(|h| !h.closed) {
                                assert_eq!(host.script, confirmed_before, "set-back left {host:?}");
                            }
                        }
                        mark = None;
                        flight_script = None;
                    }
                }
                Step::AddCustom => {
                    if let Some(s) = serve.with_custom_host() {
                        serve = s;
                    }
                }
                Step::OpenCustom => {
                    if let Some(s) = preview_open_host(&serve, 1) {
                        serve = s;
                        opened += 1;
                    }
                }
                Step::ClearCustom => {
                    if let Some(s) = preview_clear_host(&serve, 1) {
                        serve = s;
                    }
                }
                Step::Delete => {
                    let slot = slot_of(0, serve.clone());
                    let deletion = delete_preview(&slot);
                    serve = deletion.serve;
                    mark = None;
                    flight_script = None;
                    assert!(serve.hosts().iter().all(|h| h.script.is_none()));
                }
            }
            for host in serve.hosts() {
                if let Some(s) = &host.script {
                    assert!(s.starts_with(&format!("{LABEL}.")), "{s}");
                }
            }
            assert!(serve.hosts().len() <= MAX_PREVIEW_HOSTS);
            assert!(!serve.hosts()[0].closed);
            assert!(serve.epoch() >= epoch_seen);
            epoch_seen = serve.epoch();
        }
    }
    assert!(
        confirms > 1_000 && set_backs > 1_000,
        "{confirms} {set_backs}"
    );
    assert!(
        refused_labels > 1_000 && opened > 1_000,
        "{refused_labels} {opened}"
    );
}

/// A preview's serve state and production's are different types: nothing a preview command takes or returns is a
/// production `ServeState`, so a preview can't be stored where production's is, and production's commands can't be
/// handed a preview's state. This checks it at compile time, and that production's unpublish never sees a preview.
#[test]
fn a_previews_serve_state_is_a_type_of_its_own() {
    fn takes_production(_: &ServeState) {}
    let production = ServeState {
        epoch: 0,
        hosts: vec![DesiredServe {
            script: Some(script(OTHER_LABEL, ID_A)),
            version: 1,
            closed: false,
        }],
        kept_previous: None,
        in_flight: None,
    };
    takes_production(&production);
    let preview = serving(ID_A);
    // `takes_production(&preview)` doesn't compile: PreviewServe is no ServeState and derefs to none.
    let (after, _) = unpublish(&production);
    assert_eq!(preview.serving(), Some(script(LABEL, ID_A)));
    assert!(after.hosts[0].script.is_none());
}

// --- the slot's own record (M8 step 4's security review) ---------------------------------------------------------------

#[test]
fn a_slot_is_made_only_with_its_own_id_and_label_and_starts_at_epoch_zero() {
    let slot = PreviewSlot::new(SLOT, LABEL).unwrap();
    assert_eq!(slot.id(), SLOT);
    assert_eq!(slot.label(), LABEL);
    assert_eq!(slot.access_epoch(), 0);
    assert_eq!(slot.serve(), &PreviewServe::new());
    for bad_id in [
        "",
        "pvs_0123456789abcdef0123456789abcdef",
        "pvw_0123456789ABCDEF0123456789abcdef",
        "pvw_0123",
    ] {
        assert!(PreviewSlot::new(bad_id, LABEL).is_none(), "{bad_id:?}");
        assert!(
            PreviewSlot::from_stored(bad_id, LABEL, 0, PreviewServe::new()).is_none(),
            "{bad_id:?}"
        );
    }
    for bad_label in ["", "PV7Q2", "pv-7", &"a".repeat(27)] {
        assert!(PreviewSlot::new(SLOT, bad_label).is_none(), "{bad_label:?}");
    }
    // An epoch no entry can carry is no slot's.
    assert!(PreviewSlot::from_stored(SLOT, LABEL, MAX_ACCESS_EPOCH, PreviewServe::new()).is_some());
    assert!(
        PreviewSlot::from_stored(SLOT, LABEL, MAX_ACCESS_EPOCH + 1, PreviewServe::new()).is_none()
    );
    assert!(is_slot_id(SLOT) && is_slot_id(OTHER_SLOT));
}

#[test]
fn a_slots_access_epoch_only_moves_forward_and_its_id_and_label_never_change() {
    let slot = slot_of(4, serving(ID_A));
    let raised = slot.raise_access_epoch().unwrap();
    assert_eq!(raised.access_epoch(), 5);
    assert_eq!(raised.id(), SLOT);
    assert_eq!(raised.label(), LABEL);
    assert_eq!(raised.serve(), slot.serve());
    let spent = slot_of(MAX_ACCESS_EPOCH, PreviewServe::new());
    assert_eq!(spent.raise_access_epoch(), Err(EpochExhausted));
    // A new serve state keeps the slot's id, label and epoch.
    let moved = raised.with_serve(PreviewServe::new());
    assert_eq!(
        (moved.id(), moved.label(), moved.access_epoch()),
        (SLOT, LABEL, 5)
    );
    // Committing keeps them too.
    let (after, _) = preview_commit_live(
        &raised,
        0,
        &script(LABEL, ID_B),
        ID_B,
        ReleaseState::Uploading,
    )
    .unwrap();
    assert_eq!(
        (after.id(), after.label(), after.access_epoch()),
        (SLOT, LABEL, 5)
    );
}

#[test]
fn a_deletion_names_the_slot_it_retired() {
    let deletion = delete_preview(&slot_of(2, serving(ID_A)));
    assert_eq!(deletion.retire_slot, SLOT);
}
