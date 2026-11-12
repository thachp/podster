//! Releasing a room's app (ADR 0010, M6 step 3): the approval policy, which commit is releasable, a release's states,
//! script names, the release epoch and desired serve state, the unpublish triggers, the job's recheck, the caps, and
//! what Cloudflare's and the host's answers mean.

use podster_core::release::*;

const NOW: i64 = 100 * RELEASE_WINDOW_MS;
const ID: &str = "rel_0123456789abcdef0123456789abcdef";
const ID2: &str = "rel_fedcba9876543210fedcba9876543210";
const ID3: &str = "rel_00000000000000000000000000000003";

/// A small generator with a fixed seed, so the cases below are the same every run.
fn next(state: &mut u64) -> u64 {
    *state = state
        .wrapping_mul(6_364_136_223_846_793_005)
        .wrapping_add(1_442_695_040_888_963_407);
    *state >> 33
}

// --- the approval policy ---------------------------------------------------------------------------------------------

#[test]
fn the_one_approval_policy_is_person() {
    assert_eq!(
        ApprovalPolicy::parse("person"),
        Some(ApprovalPolicy::Person)
    );
    assert_eq!(ApprovalPolicy::Person.name(), "person");
    for other in ["on_merge", "Person", "person ", "", "none", "auto"] {
        assert_eq!(ApprovalPolicy::parse(other), None, "{other:?}");
    }
}

// --- which commit is releasable ----------------------------------------------------------------------------------------

const MERGED: CommitRecord = CommitRecord {
    sha: "abc123",
    provider_repo_id: 7,
    merged_by_podster: true,
    confirmed_on_default_branch: true,
    task_completed: true,
};

#[test]
fn only_a_commit_podster_merged_and_confirmed_for_a_completed_task_is_releasable() {
    assert_eq!(
        releasable_commit("abc123", "production", Some(&MERGED), 7),
        Ok(())
    );
    let refused = |record: Option<&CommitRecord>, sha: &str, repo: i64| {
        releasable_commit(sha, "production", record, repo)
    };
    // No record: a task branch's head, a commit pushed any other way.
    assert_eq!(
        refused(None, "abc123", 7),
        Err(CommitRefusal::NotReleasable)
    );
    for record in [
        CommitRecord {
            merged_by_podster: false,
            ..MERGED
        },
        CommitRecord {
            confirmed_on_default_branch: false,
            ..MERGED
        },
        CommitRecord {
            task_completed: false,
            ..MERGED
        },
    ] {
        assert_eq!(
            refused(Some(&record), "abc123", 7),
            Err(CommitRefusal::NotReleasable),
            "{record:?}"
        );
    }
    // Another repository, another sha, or none.
    assert_eq!(
        refused(Some(&MERGED), "abc123", 8),
        Err(CommitRefusal::NotReleasable)
    );
    assert_eq!(
        refused(Some(&MERGED), "abc124", 7),
        Err(CommitRefusal::NotReleasable)
    );
    let empty = CommitRecord { sha: "", ..MERGED };
    assert_eq!(
        refused(Some(&empty), "", 7),
        Err(CommitRefusal::NotReleasable)
    );
    assert_eq!(CommitRefusal::NotReleasable.code(), "commit_not_releasable");
}

#[test]
fn there_is_one_environment() {
    for env in ["staging", "Production", "preview", ""] {
        assert_eq!(
            releasable_commit("abc123", env, Some(&MERGED), 7),
            Err(CommitRefusal::UnknownEnvironment),
            "{env:?}"
        );
    }
}

// --- a release's states ----------------------------------------------------------------------------------------------

#[test]
fn every_state_and_event_is_decided_exactly() {
    use ReleaseEvent as E;
    use ReleaseState as S;
    let events = [
        E::Approve,
        E::Decline,
        E::StartUpload,
        E::UploadUnknown,
        E::UploadConfirmed,
        E::CommitLive,
        E::MarkerSeen,
        E::Replace,
        E::Unpublish,
        E::Fail,
    ];
    let allowed: &[(S, E, S)] = &[
        (S::AwaitingApproval, E::Approve, S::Queued),
        (S::AwaitingApproval, E::Decline, S::Declined),
        (S::AwaitingApproval, E::Fail, S::Failed),
        (S::Queued, E::StartUpload, S::Uploading),
        (S::Queued, E::Fail, S::Failed),
        (S::Uploading, E::UploadUnknown, S::Uncertain),
        (S::Uploading, E::CommitLive, S::Live),
        (S::Uploading, E::Fail, S::Failed),
        (S::Uncertain, E::UploadConfirmed, S::Uploading),
        (S::Uncertain, E::Fail, S::Failed),
        (S::Live, E::MarkerSeen, S::Served),
        (S::Live, E::Replace, S::Replaced),
        (S::Live, E::Unpublish, S::Unpublished),
        (S::Live, E::Fail, S::Failed),
        (S::Served, E::Replace, S::Replaced),
        (S::Served, E::Unpublish, S::Unpublished),
    ];
    for from in ReleaseState::ALL {
        for event in events {
            let expected = allowed
                .iter()
                .find(|(f, e, _)| *f == from && *e == event)
                .map(|(_, _, to)| *to);
            match expected {
                Some(to) => assert_eq!(next_state(from, event), Ok(to), "{from:?} {event:?}"),
                None => assert_eq!(
                    next_state(from, event),
                    Err(TransitionRefused { from, event }),
                    "{from:?} {event:?}"
                ),
            }
        }
    }
}

#[test]
fn a_final_state_takes_no_event_and_only_live_and_served_serve() {
    for state in ReleaseState::ALL {
        assert_eq!(
            state.is_final(),
            matches!(
                state,
                ReleaseState::Replaced
                    | ReleaseState::Unpublished
                    | ReleaseState::Declined
                    | ReleaseState::Failed
            ),
            "{state:?}"
        );
        assert_eq!(
            state.serves(),
            matches!(state, ReleaseState::Live | ReleaseState::Served),
            "{state:?}"
        );
        if state.is_final() {
            for event in [
                ReleaseEvent::Approve,
                ReleaseEvent::CommitLive,
                ReleaseEvent::MarkerSeen,
                ReleaseEvent::Fail,
                ReleaseEvent::Unpublish,
            ] {
                assert!(next_state(state, event).is_err(), "{state:?} {event:?}");
            }
        }
    }
    // A served release can't fail: only a replacement or an unpublish moves it.
    assert!(next_state(ReleaseState::Served, ReleaseEvent::Fail).is_err());
    let names: Vec<&str> = ReleaseState::ALL.iter().map(|s| s.name()).collect();
    assert_eq!(
        names,
        [
            "awaiting_approval",
            "queued",
            "uploading",
            "uncertain",
            "live",
            "served",
            "replaced",
            "unpublished",
            "declined",
            "failed"
        ]
    );
}

// --- script names ------------------------------------------------------------------------------------------------------

#[test]
fn a_label_is_one_to_twenty_six_lower_case_letters_and_digits() {
    for good in ["a", "0", "abc123", &"a".repeat(26), &"9".repeat(26)] {
        assert!(is_label(good), "{good}");
    }
    for bad in [
        "",
        &"a".repeat(27),
        "Abc",
        "a-b",
        "a.b",
        "a_b",
        "a b",
        "é",
        "a/b",
    ] {
        assert!(!is_label(bad), "{bad}");
    }
}

#[test]
fn a_release_id_is_exactly_rel_and_thirty_two_lower_hex() {
    assert!(is_release_id(ID));
    for bad in [
        "rel_0123456789abcdef0123456789abcde",   // 35
        "rel_0123456789abcdef0123456789abcdef0", // 37
        "Rel_0123456789abcdef0123456789abcdef",
        "rel_0123456789ABCDEF0123456789abcdef",
        "rel_0123456789abcdeg0123456789abcdef",
        "rel-0123456789abcdef0123456789abcdef",
        "re1_0123456789abcdef0123456789abcdef",
        "rel.0123456789abcdef0123456789abcdef",
        "rls_0123456789abcdef0123456789abcdef",
        "tsk_0123456789abcdef0123456789abcdef",
        "",
    ] {
        assert!(!is_release_id(bad), "{bad}");
        assert_eq!(
            script_name("abc", bad),
            Err(ScriptNameRefusal::BadReleaseId),
            "{bad}"
        );
        assert_eq!(
            script_owner(&format!("abc.{bad}")),
            ScriptOwner::Foreign,
            "{bad}"
        );
    }
}

#[test]
fn a_script_name_is_the_label_a_dot_and_the_id_and_at_most_sixty_three_characters() {
    let longest = script_name(&"z".repeat(26), ID).unwrap_or_default();
    assert_eq!(longest.len(), MAX_SCRIPT_NAME_LEN);
    assert_eq!(longest, format!("{}.{ID}", "z".repeat(26)));
    assert_eq!(
        script_name(&"z".repeat(27), ID),
        Err(ScriptNameRefusal::BadLabel)
    );
    assert_eq!(script_name("a.b", ID), Err(ScriptNameRefusal::BadLabel));
    assert_eq!(
        script_name("abc", "rel_x"),
        Err(ScriptNameRefusal::BadReleaseId)
    );
    assert_eq!(script_name("abc", ""), Err(ScriptNameRefusal::BadReleaseId));
}

#[test]
fn no_name_over_sixty_three_characters_is_podsters() {
    // The cap is implied by the parts' own rules, 26 + 1 + 36, and kept as a guard: every longer name is foreign,
    // whatever it holds.
    let mut state = 0x63_u64;
    for extra in 1..=40 {
        let label = "a".repeat(26);
        let longer = format!("{label}.{ID}{}", "0".repeat(extra));
        assert_eq!(script_owner(&longer), ScriptOwner::Foreign, "{extra}");
        let id = made_id(&mut state);
        let name = format!("{}.{id}", "b".repeat(26));
        assert_eq!(name.len(), MAX_SCRIPT_NAME_LEN);
        assert!(matches!(script_owner(&name), ScriptOwner::Podster { .. }));
    }
}

#[test]
fn a_name_that_doesnt_fit_the_rule_isnt_podsters() {
    for foreign in [
        "",
        "abc",
        "abc.",
        ".rel_0123456789abcdef0123456789abcdef",
        "ABC.rel_0123456789abcdef0123456789abcdef",
        "abc.rel_0123456789abcdef0123456789abcdef.x",
        "abc..rel_0123456789abcdef0123456789abcdef",
        "abc_rel_0123456789abcdef0123456789abcdef",
        "abc.rel_0123456789abcdef0123456789abcdeg",
        "my-worker",
        &format!("{}.{ID}", "a".repeat(27)),
    ] {
        assert_eq!(script_owner(foreign), ScriptOwner::Foreign, "{foreign}");
    }
}

/// Labels and IDs made from the generator: every length of label, every hexadecimal digit.
fn made_label(state: &mut u64) -> String {
    const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    let len = 1 + (next(state) % 26) as usize;
    (0..len)
        .filter_map(|_| {
            ALPHABET
                .get((next(state) % 36) as usize)
                .map(|b| char::from(*b))
        })
        .collect()
}

fn made_id(state: &mut u64) -> String {
    let hex: String = (0..32)
        .filter_map(|_| char::from_digit((next(state) % 16) as u32, 16))
        .collect();
    format!("rel_{hex}")
}

#[test]
fn a_script_name_round_trips_and_no_label_claims_another_rooms_script() {
    let mut state = 0x6e_u64;
    for case in 0..5_000 {
        let label = made_label(&mut state);
        let other = if case % 3 == 0 {
            // A label that is a prefix of, or extends, this one: the collision a looser rule would allow.
            let cut = label.len().saturating_sub(1).max(1);
            label.get(..cut).unwrap_or("a").to_owned() + if case % 2 == 0 { "" } else { "0" }
        } else {
            made_label(&mut state)
        };
        let id = made_id(&mut state);
        let name = script_name(&label, &id).unwrap_or_default();
        assert!(name.len() <= MAX_SCRIPT_NAME_LEN, "case {case}: {name}");
        assert_eq!(
            script_owner(&name),
            ScriptOwner::Podster {
                label: &label,
                release_id: &id
            },
            "case {case}"
        );
        if other != label {
            // Matching by label is the part before the one `.`, so another label never claims this name.
            assert_ne!(
                script_owner(&name),
                ScriptOwner::Podster {
                    label: &other,
                    release_id: &id
                },
                "case {case}: {other} claimed {name}"
            );
            assert!(
                !name.starts_with(&format!("{other}.")),
                "case {case}: {other} prefixes {name}"
            );
        }
    }
}

#[test]
fn a_label_is_made_from_128_random_bits_and_checked_before_use() {
    let zero = label_from_random([0; 16]);
    assert_eq!(zero, "a".repeat(26));
    let mut state = 0x1abe1_u64;
    let mut seen = std::collections::BTreeSet::new();
    for _ in 0..2_000 {
        let mut random = [0u8; 16];
        for byte in &mut random {
            *byte = (next(&mut state) & 0xff) as u8;
        }
        let label = label_from_random(random);
        assert_eq!(label.len(), MAX_LABEL_LEN);
        assert!(is_label(&label), "{label}");
        assert_eq!(label, label_from_random(random));
        seen.insert(label);
    }
    assert_eq!(
        seen.len(),
        2_000,
        "distinct random bytes made the same label"
    );
    assert!(label_acceptable("abc234", &[]));
    assert!(!label_acceptable("xpodsterx", &[]));
    assert!(!label_acceptable("abcgardenxyz", &["Garden"]));
    assert!(label_acceptable("abcgardenxyz", &["", "orchard"]));
    assert!(!label_acceptable("ABC", &[]));
}

// --- the release epoch and the desired serve state ---------------------------------------------------------------

fn host(script: Option<&str>, version: u64) -> DesiredServe {
    DesiredServe {
        script: script.map(str::to_owned),
        version,
        closed: false,
    }
}

fn serving(script: Option<&str>, hosts: usize, epoch: u64) -> ServeState {
    ServeState {
        epoch,
        hosts: (0..hosts).map(|i| host(script, 10 + i as u64)).collect(),
        kept_previous: None,
    }
}

fn scripts(state: &ServeState) -> Vec<Option<&str>> {
    state.hosts.iter().map(|h| h.script.as_deref()).collect()
}

fn versions(state: &ServeState) -> Vec<u64> {
    state.hosts.iter().map(|h| h.version).collect()
}

#[test]
fn a_live_commit_sets_every_open_host_under_its_own_epoch_only() {
    let state = serving(None, 2, 4);
    let Ok((after, mark)) = commit_live(&state, 4, "lab.rel_a") else {
        unreachable!("refused");
    };
    assert_eq!(scripts(&after), [Some("lab.rel_a"), Some("lab.rel_a")]);
    assert_eq!(versions(&after), [11, 12]);
    assert_eq!(after.epoch, 4);
    assert_eq!(
        mark,
        CommitMark {
            epoch: 4,
            versions: vec![Some(11), Some(12)],
            before: vec![None, None]
        }
    );
    assert_eq!(
        commit_live(&state, 3, "lab.rel_a"),
        Err(CommitLiveRefusal::EpochMoved)
    );
    assert_eq!(
        commit_live(&state, 5, "lab.rel_a"),
        Err(CommitLiveRefusal::EpochMoved)
    );
}

#[test]
fn a_repeated_commit_is_refused_by_the_function_itself() {
    let Ok((live, _)) = commit_live(&serving(None, 2, 1), 1, "lab.rel_a") else {
        unreachable!("refused");
    };
    assert_eq!(
        commit_live(&live, 1, "lab.rel_a"),
        Err(CommitLiveRefusal::AlreadyLive)
    );
    assert_eq!(
        CommitLiveRefusal::AlreadyLive.code(),
        "release_already_live"
    );
    // A closed host naming it doesn't count: only an open host serves.
    let mut closed = serving(None, 2, 1);
    if let Some(h) = closed.hosts.get_mut(1) {
        *h = DesiredServe {
            script: Some("lab.rel_a".into()),
            version: 5,
            closed: true,
        };
    }
    assert!(commit_live(&closed, 1, "lab.rel_a").is_ok());
}

#[test]
fn the_epoch_and_versions_fail_closed_at_their_limits() {
    let spent = serving(None, 1, u64::MAX);
    assert_eq!(
        commit_live(&spent, u64::MAX, "lab.rel_a"),
        Err(CommitLiveRefusal::Exhausted)
    );
    let mut full = serving(None, 1, 3);
    if let Some(h) = full.hosts.first_mut() {
        h.version = u64::MAX - 1;
    }
    assert_eq!(
        commit_live(&full, 3, "lab.rel_a"),
        Err(CommitLiveRefusal::Exhausted)
    );
    // An unpublish never fails: at the limit it pins the epoch, which no commit accepts again.
    let (down, _) = unpublish(&spent, None);
    assert_eq!(down.epoch, u64::MAX);
    assert_eq!(
        commit_live(&down, u64::MAX, "lab.rel_a"),
        Err(CommitLiveRefusal::Exhausted)
    );
    let (down, _) = unpublish(&serving(Some("lab.rel_a"), 1, u64::MAX - 1), None);
    assert_eq!(down.epoch, u64::MAX);
    assert_eq!(scripts(&down), [None]);
    assert_eq!(
        rollback(&down, u64::MAX, true),
        Err(RollbackRefusal::NotKept)
    );
}

#[test]
fn a_room_made_private_mid_publish_never_goes_live() {
    let started = 4;
    let state = serving(Some("lab.rel_old"), 1, started);
    let (after, delete) = unpublish(&state, None);
    assert_eq!(after.epoch, 5);
    assert_eq!(scripts(&after), [None]);
    assert_eq!(delete, ["lab.rel_old"]);
    assert_eq!(
        commit_live(&after, started, "lab.rel_new"),
        Err(CommitLiveRefusal::EpochMoved)
    );
    let commit = MERGED;
    let mut check = open_recheck(&commit);
    check.room.public = false;
    check.epoch_now = 5;
    check.epoch_at_start = started;
    assert_eq!(
        recheck(&check),
        Err(RecheckFailure::Trigger(UnpublishTrigger::RoomMadePrivate))
    );
    assert_eq!(
        RecheckFailure::Trigger(UnpublishTrigger::RoomMadePrivate).code(),
        "release_needs_public_room"
    );
}

#[test]
fn a_release_never_writes_to_a_cleared_or_suspended_custom_host() {
    // The default host and a custom host both serve the first release.
    let Ok((live, _)) = commit_live(&serving(None, 2, 7), 7, "lab.rel_1") else {
        unreachable!("refused");
    };
    // An operator suspends the custom hostname, or its claim starts ending: the room clears and closes that host.
    let Some(cleared) = clear_host(&live, 1) else {
        unreachable!("no host");
    };
    // A release already uploading commits: the default host switches, the closed custom host stays at nothing.
    let Ok((second, mark)) = commit_live(&cleared, 7, "lab.rel_2") else {
        unreachable!("refused");
    };
    assert_eq!(scripts(&second), [Some("lab.rel_2"), None]);
    assert!(second.hosts.get(1).is_some_and(|h| h.closed));
    assert_eq!(mark.versions.get(1), Some(&None));
    // A rollback doesn't reopen it either, and a set-back leaves it alone.
    let mut kept = second.clone();
    kept.kept_previous = Some("lab.rel_1".into());
    let Ok((rolled, _)) = rollback(&kept, 7, true) else {
        unreachable!("refused");
    };
    assert_eq!(scripts(&rolled), [Some("lab.rel_1"), None]);
    let back = set_back(&second, &mark, "lab.rel_2");
    assert_eq!(scripts(&back.state), [Some("lab.rel_1"), None]);
    assert_eq!(back.reverted, [0]);
    // Only a new claim, active at Cloudflare, opens it again, with the release last confirmed served.
    let Some(reopened) = open_host(&second, 1, Some("lab.rel_2")) else {
        unreachable!("no host");
    };
    assert_eq!(scripts(&reopened), [Some("lab.rel_2"), Some("lab.rel_2")]);
    assert!(reopened.hosts.iter().all(|h| !h.closed));
    assert_eq!(open_host(&second, 2, None), None);
}

#[test]
fn a_host_opened_between_a_commit_and_its_marker_never_takes_the_unconfirmed_script() {
    // The first release is served on the default host; the custom host is closed.
    let Ok((live, _)) = commit_live(&serving(None, 2, 4), 4, "lab.rel_1") else {
        unreachable!("refused");
    };
    let Some(closed) = clear_host(&live, 1) else {
        unreachable!("no host");
    };
    // A second release commits; its marker hasn't come back.
    let Ok((second, mark)) = commit_live(&closed, 4, "lab.rel_2") else {
        unreachable!("refused");
    };
    // A new claim goes active in that window: the host opens on the release last confirmed served, not the second.
    let Some(opened) = open_host(&second, 1, Some("lab.rel_1")) else {
        unreachable!("no host");
    };
    assert_eq!(scripts(&opened), [Some("lab.rel_2"), Some("lab.rel_1")]);
    // The marker never comes back: the default host is set back, the opened host stays where it is, and the failed
    // script is named by nothing, so it may be deleted.
    let back = set_back(&opened, &mark, "lab.rel_2");
    assert_eq!(scripts(&back.state), [Some("lab.rel_1"), Some("lab.rel_1")]);
    assert_eq!(back.reverted, [0]);
    assert!(back.delete_script);
    // With nothing ever served, it opens on nothing.
    let Some(empty) = open_host(&second, 1, None) else {
        unreachable!("no host");
    };
    assert_eq!(scripts(&empty), [Some("lab.rel_2"), None]);
    assert!(set_back(&empty, &mark, "lab.rel_2").delete_script);
}

#[test]
fn an_unpublish_keeps_closed_hosts_closed() {
    let Some(state) = clear_host(&serving(Some("lab.rel_1"), 2, 1), 1) else {
        unreachable!("no host");
    };
    let (down, _) = unpublish(&state, None);
    assert_eq!(
        down.hosts.iter().map(|h| h.closed).collect::<Vec<_>>(),
        [false, true]
    );
    // So a release committed after it, under the new epoch, still doesn't write to the closed host.
    let Ok((after, _)) = commit_live(&down, down.epoch, "lab.rel_2") else {
        unreachable!("refused");
    };
    assert_eq!(scripts(&after), [Some("lab.rel_2"), None]);
}

#[test]
fn a_second_release_failing_after_the_first_is_live_leaves_the_first_serving() {
    let first = "lab.rel_1";
    let Ok((live, _)) = commit_live(&serving(None, 1, 2), 2, first) else {
        unreachable!("first refused");
    };
    assert_eq!(scripts(&live), [Some(first)]);
    assert_eq!(
        next_state(ReleaseState::Uploading, ReleaseEvent::Fail),
        Ok(ReleaseState::Failed)
    );
    let Ok((second, mark)) = commit_live(&live, 2, "lab.rel_2") else {
        unreachable!("second refused");
    };
    assert_eq!(
        marker_outcome(None, "rel_2", MARKER_WAIT_MS),
        MarkerOutcome::Failed
    );
    let back = set_back(&second, &mark, "lab.rel_2");
    assert_eq!(scripts(&back.state), [Some(first)]);
    assert_eq!(back.reverted, [0]);
    assert!(back.delete_script);
    assert_eq!(
        versions(&back.state),
        versions(&second).iter().map(|v| v + 1).collect::<Vec<_>>()
    );
    assert_eq!(
        next_state(ReleaseState::Live, ReleaseEvent::Fail),
        Ok(ReleaseState::Failed)
    );
}

#[test]
fn a_set_back_is_host_by_host_and_keeps_a_script_something_still_serves() {
    let Ok((live, mark)) = commit_live(&serving(Some("lab.rel_1"), 2, 3), 3, "lab.rel_2") else {
        unreachable!("refused");
    };
    // The custom host changed since the commit: here, opened again after a claim, still naming the failed script.
    let mut changed = live.clone();
    if let Some(h) = changed.hosts.get_mut(1) {
        h.version += 1;
    }
    let back = set_back(&changed, &mark, "lab.rel_2");
    assert_eq!(back.reverted, [0]);
    assert_eq!(scripts(&back.state), [Some("lab.rel_1"), Some("lab.rel_2")]);
    // So its script is still served, and the caller mustn't delete it.
    assert!(!back.delete_script);
}

#[test]
fn a_set_back_needs_the_commits_epoch() {
    // Hand-built: the epoch moved but every version is still what the commit wrote. Nothing is set back.
    let state = ServeState {
        epoch: 9,
        hosts: vec![host(Some("lab.rel_2"), 11)],
        kept_previous: None,
    };
    let mark = CommitMark {
        epoch: 8,
        versions: vec![Some(11)],
        before: vec![Some("lab.rel_1".into())],
    };
    let back = set_back(&state, &mark, "lab.rel_2");
    assert_eq!(back.state, state);
    assert!(back.reverted.is_empty());
    assert!(!back.delete_script);
    // The same with the epoch right sets it back.
    let same = CommitMark { epoch: 9, ..mark };
    assert_eq!(set_back(&state, &same, "lab.rel_2").reverted, [0]);
}

#[test]
fn a_set_back_after_an_unpublish_changes_nothing() {
    let Ok((live, mark)) = commit_live(&serving(Some("lab.rel_1"), 2, 3), 3, "lab.rel_2") else {
        unreachable!("refused");
    };
    let (down, delete) = unpublish(&live, Some(&mark));
    // The unpublish deletes the failed release's script and the one live before it, which sat only in the mark.
    assert_eq!(delete, ["lab.rel_1", "lab.rel_2"]);
    let back = set_back(&down, &mark, "lab.rel_2");
    assert!(back.reverted.is_empty());
    assert_eq!(scripts(&back.state), [None, None]);
    assert!(back.delete_script);
    let Some(cleared) = clear_host(&live, 1) else {
        unreachable!("no host");
    };
    assert_eq!(set_back(&cleared, &mark, "lab.rel_2").reverted, [0]);
    let Ok((other, _)) = commit_live(&live, 3, "lab.rel_3") else {
        unreachable!("refused");
    };
    assert!(set_back(&other, &mark, "lab.rel_2").reverted.is_empty());
    let short = CommitMark {
        versions: vec![],
        before: vec![],
        ..mark.clone()
    };
    assert!(set_back(&live, &short, "lab.rel_2").reverted.is_empty());
}

#[test]
fn a_late_or_duplicated_job_changes_nothing() {
    let state = serving(None, 1, 6);
    let (down, _) = unpublish(&state, None);
    assert_eq!(
        commit_live(&down, 6, "lab.rel_late"),
        Err(CommitLiveRefusal::EpochMoved)
    );
    for done in [
        ReleaseState::Failed,
        ReleaseState::Unpublished,
        ReleaseState::Declined,
        ReleaseState::Replaced,
    ] {
        assert!(
            next_state(done, ReleaseEvent::CommitLive).is_err(),
            "{done:?}"
        );
        assert!(
            next_state(done, ReleaseEvent::MarkerSeen).is_err(),
            "{done:?}"
        );
    }
    assert!(next_state(ReleaseState::Live, ReleaseEvent::CommitLive).is_err());
    assert!(next_state(ReleaseState::Served, ReleaseEvent::MarkerSeen).is_err());
    let Ok((live, mark)) = commit_live(&state, 6, "lab.rel_a") else {
        unreachable!("refused");
    };
    assert_eq!(
        commit_live(&live, 6, "lab.rel_a"),
        Err(CommitLiveRefusal::AlreadyLive)
    );
    let Ok((newer, _)) = commit_live(&live, 6, "lab.rel_b") else {
        unreachable!("refused");
    };
    assert!(set_back(&newer, &mark, "lab.rel_a").reverted.is_empty());
    assert_eq!(
        next_state(ReleaseState::Uploading, ReleaseEvent::UploadUnknown),
        Ok(ReleaseState::Uncertain)
    );
    assert_eq!(
        next_state(ReleaseState::Uncertain, ReleaseEvent::UploadConfirmed),
        Ok(ReleaseState::Uploading)
    );
    assert!(next_state(ReleaseState::Uncertain, ReleaseEvent::CommitLive).is_err());
}

#[test]
fn a_served_release_keeps_the_one_before_and_deletes_the_one_before_that() {
    let mut state = serving(Some("lab.rel_2"), 1, 1);
    state.kept_previous = Some("lab.rel_1".into());
    assert_eq!(
        after_served(&state, Some("lab.rel_2"), "lab.rel_3"),
        AfterServed {
            kept_previous: Some("lab.rel_2".into()),
            delete: Some("lab.rel_1".into())
        }
    );
    assert_eq!(
        after_served(&serving(None, 1, 1), None, "lab.rel_1"),
        AfterServed {
            kept_previous: None,
            delete: None
        }
    );
    assert_eq!(
        after_served(&state, Some("lab.rel_2"), "lab.rel_1"),
        AfterServed {
            kept_previous: Some("lab.rel_2".into()),
            delete: None
        }
    );
}

#[test]
fn a_rollback_switches_only_to_a_kept_script_cloudflare_says_exists() {
    let mut state = serving(Some("lab.rel_2"), 2, 9);
    assert_eq!(rollback(&state, 9, true), Err(RollbackRefusal::NotKept));
    state.kept_previous = Some("lab.rel_1".into());
    assert_eq!(rollback(&state, 9, false), Err(RollbackRefusal::NotKept));
    assert_eq!(
        rollback(&state, 8, true),
        Err(RollbackRefusal::Commit(CommitLiveRefusal::EpochMoved))
    );
    let Ok((back, mark)) = rollback(&state, 9, true) else {
        unreachable!("refused");
    };
    assert_eq!(scripts(&back), [Some("lab.rel_1"), Some("lab.rel_1")]);
    assert_eq!(
        mark.before,
        [Some("lab.rel_2".to_owned()), Some("lab.rel_2".to_owned())]
    );
    let (down, _) = unpublish(&state, None);
    assert_eq!(down.kept_previous, None);
    assert_eq!(
        rollback(&down, down.epoch, true),
        Err(RollbackRefusal::NotKept)
    );
    assert_eq!(RollbackRefusal::NotKept.code(), "rollback_not_kept");
}

/// A change to the room's facts that fires one trigger.
type FactFlip = fn(&mut RoomReleaseFacts);
/// A change to the recheck's inputs that fails it one way.
type RecheckChange = fn(&mut Recheck);

// --- unpublishing ------------------------------------------------------------------------------------------------

#[test]
fn an_unpublish_raises_the_epoch_clears_every_host_and_forgets_the_kept_script() {
    let mut state = serving(Some("lab.rel_2"), 2, 4);
    state.kept_previous = Some("lab.rel_1".into());
    let (after, delete) = unpublish(&state, None);
    assert_eq!(after.epoch, 5);
    assert_eq!(scripts(&after), [None, None]);
    assert_eq!(versions(&after), [11, 12]);
    assert_eq!(after.kept_previous, None);
    assert_eq!(delete, ["lab.rel_1", "lab.rel_2"]);
    let (quiet, none) = unpublish(&serving(None, 1, 0), None);
    assert_eq!((quiet.epoch, none.len()), (1, 0));
}

#[test]
fn a_claim_ending_clears_and_closes_its_host_alone() {
    let state = serving(Some("lab.rel_1"), 2, 3);
    let Some(cleared) = clear_host(&state, 1) else {
        unreachable!("no host");
    };
    assert_eq!(scripts(&cleared), [Some("lab.rel_1"), None]);
    assert_eq!(cleared.epoch, 3);
    assert_eq!(versions(&cleared), [10, 12]);
    assert_eq!(
        cleared.hosts.iter().map(|h| h.closed).collect::<Vec<_>>(),
        [false, true]
    );
    assert_eq!(clear_host(&state, 2), None);
}

#[test]
fn each_fact_fires_exactly_its_trigger() {
    assert_eq!(unpublish_triggers(&RoomReleaseFacts::OPEN), []);
    let flips: [(FactFlip, UnpublishTrigger); 11] = [
        (
            |f| f.release_on_in_room = false,
            UnpublishTrigger::ReleaseOffInRoom,
        ),
        (
            |f| f.deployment_allows_release = false,
            UnpublishTrigger::ReleaseOffForDeployment,
        ),
        (|f| f.archived = true, UnpublishTrigger::RoomArchived),
        (|f| f.deleted = true, UnpublishTrigger::RoomDeleted),
        (|f| f.public = false, UnpublishTrigger::RoomMadePrivate),
        (
            |f| f.organization_exists = false,
            UnpublishTrigger::OrganizationDeleted,
        ),
        (
            |f| f.public_surface_suspended = true,
            UnpublishTrigger::PublicSurfaceSuspended,
        ),
        (|f| f.app_suspended = true, UnpublishTrigger::AppSuspended),
        (
            |f| f.organization_may_release = false,
            UnpublishTrigger::ReleaseTakenFromOrganization,
        ),
        (
            |f| f.repository_ready = false,
            UnpublishTrigger::RepositoryNotReady,
        ),
        (
            |f| f.someone_may_release = false,
            UnpublishTrigger::NoReleaserLeft,
        ),
    ];
    let mut all = RoomReleaseFacts::OPEN;
    for (flip, trigger) in flips {
        let mut facts = RoomReleaseFacts::OPEN;
        flip(&mut facts);
        assert_eq!(unpublish_triggers(&facts), [trigger], "{trigger:?}");
        flip(&mut all);
    }
    assert_eq!(unpublish_triggers(&all), UnpublishTrigger::ALL);
    let codes: Vec<&str> = UnpublishTrigger::ALL.iter().map(|t| t.code()).collect();
    assert_eq!(codes.len(), 11);
    assert!(codes.contains(&"repo_not_ready"));
}

// --- the recheck ------------------------------------------------------------------------------------------------------

fn open_recheck<'a>(commit: &'a CommitRecord<'a>) -> Recheck<'a> {
    Recheck {
        room: RoomReleaseFacts::OPEN,
        domain_stopped: false,
        config_version_now: 3,
        config_version_asked: 3,
        requester_may_release_now: true,
        approver_may_approve_now: true,
        reviewer_rule_holds: true,
        commit: Some(commit),
        asked_sha: "abc123",
        room_repo_id: 7,
        epoch_now: 2,
        epoch_at_start: 2,
    }
}

#[test]
fn the_recheck_passes_only_when_everything_still_holds() {
    let commit = MERGED;
    assert_eq!(recheck(&open_recheck(&commit)), Ok(()));
    let cases: [(RecheckChange, RecheckFailure); 18] = [
        (
            |r| r.room.deployment_allows_release = false,
            RecheckFailure::Trigger(UnpublishTrigger::ReleaseOffForDeployment),
        ),
        (|r| r.domain_stopped = true, RecheckFailure::DomainStopped),
        (
            |r| r.room.organization_exists = false,
            RecheckFailure::Trigger(UnpublishTrigger::OrganizationDeleted),
        ),
        (
            |r| r.room.organization_may_release = false,
            RecheckFailure::Trigger(UnpublishTrigger::ReleaseTakenFromOrganization),
        ),
        (
            |r| r.room.deleted = true,
            RecheckFailure::Trigger(UnpublishTrigger::RoomDeleted),
        ),
        (
            |r| r.room.public = false,
            RecheckFailure::Trigger(UnpublishTrigger::RoomMadePrivate),
        ),
        (
            |r| r.room.archived = true,
            RecheckFailure::Trigger(UnpublishTrigger::RoomArchived),
        ),
        (
            |r| r.room.public_surface_suspended = true,
            RecheckFailure::Trigger(UnpublishTrigger::PublicSurfaceSuspended),
        ),
        (
            |r| r.room.app_suspended = true,
            RecheckFailure::Trigger(UnpublishTrigger::AppSuspended),
        ),
        (
            |r| r.room.repository_ready = false,
            RecheckFailure::Trigger(UnpublishTrigger::RepositoryNotReady),
        ),
        (
            |r| r.room.release_on_in_room = false,
            RecheckFailure::Trigger(UnpublishTrigger::ReleaseOffInRoom),
        ),
        (|r| r.config_version_now = 4, RecheckFailure::ConfigChanged),
        (
            |r| r.requester_may_release_now = false,
            RecheckFailure::RequesterLostAuthority,
        ),
        (
            |r| r.approver_may_approve_now = false,
            RecheckFailure::ApproverLostAuthority,
        ),
        (
            |r| r.room.someone_may_release = false,
            RecheckFailure::Trigger(UnpublishTrigger::NoReleaserLeft),
        ),
        (
            |r| r.reviewer_rule_holds = false,
            RecheckFailure::ReviewerRuleChanged,
        ),
        (
            |r| r.commit = None,
            RecheckFailure::Commit(CommitRefusal::NotReleasable),
        ),
        (|r| r.epoch_now = 3, RecheckFailure::EpochMoved),
    ];
    for (i, (change, expected)) in cases.iter().enumerate() {
        let mut alone = open_recheck(&commit);
        change(&mut alone);
        assert_eq!(recheck(&alone), Err(*expected), "{expected:?} alone");
        // Every check after it failing too doesn't change the answer: the first in order is the reason.
        let mut with_later = open_recheck(&commit);
        for (later, _) in cases.iter().skip(i) {
            later(&mut with_later);
        }
        assert_eq!(recheck(&with_later), Err(*expected), "{expected:?} first");
    }
    assert_eq!(RecheckFailure::EpochMoved.code(), "release_epoch_moved");
}

// --- caps and budgets -------------------------------------------------------------------------------------------------

#[test]
fn twenty_releases_a_room_in_a_rolling_day() {
    let start = window_start(NOW, RELEASE_WINDOW_MS);
    assert_eq!(start, NOW - RELEASE_WINDOW_MS + 1);
    let recent = |n: usize, at: i64| vec![at; n];
    assert_eq!(release_allowed_today(&recent(19, NOW), NOW), Ok(()));
    assert_eq!(
        release_allowed_today(&recent(20, NOW), NOW),
        Err(ReleaseCapRefusal::DailyLimit)
    );
    // The window's edge: a request exactly a day old has left it, one a millisecond younger hasn't.
    assert_eq!(
        release_allowed_today(&recent(20, start), NOW),
        Err(ReleaseCapRefusal::DailyLimit)
    );
    assert_eq!(release_allowed_today(&recent(20, start - 1), NOW), Ok(()));
    let mut mixed = recent(19, NOW - 1);
    mixed.extend(recent(50, start - 1));
    assert_eq!(release_allowed_today(&mixed, NOW), Ok(()));
    assert_eq!(ReleaseCapRefusal::DailyLimit.code(), "release_limit");
}

#[test]
fn a_release_costs_two_tree_reads_and_one_a_file_within_three_thousand_an_hour() {
    assert_eq!(reads_for_release(300), 302);
    assert_eq!(reads_for_release(0), 2);
    assert_eq!(reads_for_release(u32::MAX), u32::MAX);
    assert_eq!(reads_fit(0, 302), Ok(()));
    assert_eq!(reads_fit(2_698, 302), Ok(()));
    assert_eq!(reads_fit(2_699, 302), Err(ReleaseCapRefusal::ReadBudget));
    assert_eq!(reads_fit(u32::MAX, 2), Err(ReleaseCapRefusal::ReadBudget));
    // Nine full-size releases fit an hour, and a tenth doesn't.
    assert_eq!(reads_fit(9 * 302 - 302, 302), Ok(()));
    assert_eq!(reads_fit(9 * 302, 302), Err(ReleaseCapRefusal::ReadBudget));
}

// --- Cloudflare's and the host's answers ----------------------------------------------------------------------------

#[test]
fn a_script_is_gone_on_exactly_two_answers() {
    assert!(script_gone(ScriptAnswer::Read {
        status: 200,
        script_null: true
    }));
    assert!(script_gone(ScriptAnswer::Delete {
        status: 404,
        code: Some(10007)
    }));
    for not_gone in [
        ScriptAnswer::Read {
            status: 404,
            script_null: true,
        },
        ScriptAnswer::Read {
            status: 404,
            script_null: false,
        },
        ScriptAnswer::Read {
            status: 200,
            script_null: false,
        },
        ScriptAnswer::Read {
            status: 500,
            script_null: true,
        },
        ScriptAnswer::Delete {
            status: 404,
            code: None,
        },
        ScriptAnswer::Delete {
            status: 404,
            code: Some(10000),
        },
        ScriptAnswer::Delete {
            status: 200,
            code: None,
        },
        ScriptAnswer::Delete {
            status: 500,
            code: Some(10007),
        },
    ] {
        assert!(!script_gone(not_gone), "{not_gone:?}");
    }
    assert!(script_exists(ScriptAnswer::Read {
        status: 200,
        script_null: false
    }));
    assert!(!script_exists(ScriptAnswer::Read {
        status: 200,
        script_null: true
    }));
    assert!(!script_exists(ScriptAnswer::Read {
        status: 404,
        script_null: false
    }));
    assert!(!script_exists(ScriptAnswer::Delete {
        status: 200,
        code: None
    }));
}

#[test]
fn the_marker_is_waited_for_thirty_seconds_and_must_be_this_releases() {
    assert_eq!(
        marker_outcome(Some("rel_1"), "rel_1", 0),
        MarkerOutcome::Served
    );
    assert_eq!(
        marker_outcome(Some("rel_1"), "rel_1", MARKER_WAIT_MS + 5),
        MarkerOutcome::Served
    );
    assert_eq!(
        marker_outcome(None, "rel_1", MARKER_WAIT_MS - 1),
        MarkerOutcome::Wait
    );
    assert_eq!(
        marker_outcome(None, "rel_1", MARKER_WAIT_MS),
        MarkerOutcome::Failed
    );
    assert_eq!(
        marker_outcome(Some("rel_0"), "rel_1", 10),
        MarkerOutcome::Wait
    );
    assert_eq!(
        marker_outcome(Some("rel_0"), "rel_1", MARKER_WAIT_MS),
        MarkerOutcome::Failed
    );
    assert_eq!(MARKER_WAIT_MS, 30_000);
}

#[test]
fn the_hourly_reconcile_deletes_only_what_fits_the_rule_and_no_room_claims() {
    let name = format!("abc.{ID}");
    assert_eq!(
        reconcile_script(&name, RoomClaim::Claims, NOW),
        ScriptReconcile::Keep
    );
    assert_eq!(
        reconcile_script(&name, RoomClaim::Disowns, NOW),
        ScriptReconcile::Delete
    );
    assert_eq!(
        reconcile_script(&name, RoomClaim::NoRoom, NOW),
        ScriptReconcile::ReportUnowned
    );
    // A release still uploading keeps its script for less than an hour, and not after.
    let since = NOW - IN_FLIGHT_EXEMPTION_MS;
    assert_eq!(
        reconcile_script(&name, RoomClaim::Uploading { since: since + 1 }, NOW),
        ScriptReconcile::Keep
    );
    assert_eq!(
        reconcile_script(&name, RoomClaim::Uploading { since }, NOW),
        ScriptReconcile::Delete
    );
    // A name that doesn't fit the rule is reported and never deleted, whatever a room says.
    for room in [
        RoomClaim::Claims,
        RoomClaim::Disowns,
        RoomClaim::NoRoom,
        RoomClaim::Uploading { since: 0 },
    ] {
        assert_eq!(
            reconcile_script("someone-elses-worker", room, NOW),
            ScriptReconcile::ReportForeign
        );
        assert_eq!(
            reconcile_script(&format!("ABC.{ID2}"), room, NOW),
            ScriptReconcile::ReportForeign
        );
    }
    assert!(is_release_id(ID3));
}
