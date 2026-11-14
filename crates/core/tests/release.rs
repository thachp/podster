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
        in_flight: None,
    }
}

fn scripts(state: &ServeState) -> Vec<Option<&str>> {
    state.hosts.iter().map(|h| h.script.as_deref()).collect()
}

/// A release committed and then confirmed served by its marker, as the room's state is once it is live: no commit in
/// flight.
fn served_live(
    state: &ServeState,
    epoch: u64,
    script: &str,
) -> Result<(ServeState, CommitMark), CommitLiveRefusal> {
    let (committed, mark) = commit_live(state, epoch, script, script, ReleaseState::Uploading)?;
    let confirmed =
        confirm_served(&committed, &mark, script).map_err(|_| CommitLiveRefusal::EpochMoved)?;
    Ok((confirmed.state, mark))
}

/// A set-back the test expects to happen: the commit in flight's own failure.
fn applied(state: &ServeState, mark: &CommitMark, script: &str) -> SetBack {
    let Ok(back) = set_back(state, mark, script) else {
        unreachable!("stale set-back");
    };
    back
}

fn versions(state: &ServeState) -> Vec<u64> {
    state.hosts.iter().map(|h| h.version).collect()
}

#[test]
fn a_live_commit_sets_every_open_host_under_its_own_epoch_only() {
    let state = serving(None, 2, 4);
    let Ok((after, mark)) =
        commit_live(&state, 4, "lab.rel_a", "lab.rel_a", ReleaseState::Uploading)
    else {
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
        commit_live(&state, 3, "lab.rel_a", "lab.rel_a", ReleaseState::Uploading),
        Err(CommitLiveRefusal::EpochMoved)
    );
    assert_eq!(
        commit_live(&state, 5, "lab.rel_a", "lab.rel_a", ReleaseState::Uploading),
        Err(CommitLiveRefusal::EpochMoved)
    );
}

#[test]
fn a_repeated_commit_is_refused_by_the_function_itself() {
    let first = commit_live(
        &serving(None, 2, 1),
        1,
        "lab.rel_a",
        "lab.rel_a",
        ReleaseState::Uploading,
    );
    let Ok((committed, _)) = first.clone() else {
        unreachable!("refused");
    };
    // While its marker is awaited, the same commit again is a replay of the first answer, and another is refused.
    assert_eq!(
        commit_live(
            &committed,
            1,
            "lab.rel_a",
            "lab.rel_a",
            ReleaseState::Uploading
        ),
        first
    );
    assert_eq!(
        commit_live(
            &committed,
            1,
            "lab.rel_b",
            "lab.rel_b",
            ReleaseState::Uploading
        ),
        Err(CommitLiveRefusal::InFlight)
    );
    let Ok((live, _)) = served_live(&serving(None, 2, 1), 1, "lab.rel_a") else {
        unreachable!("refused");
    };
    assert_eq!(
        commit_live(&live, 1, "lab.rel_a", "lab.rel_a", ReleaseState::Uploading),
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
    assert!(commit_live(
        &closed,
        1,
        "lab.rel_a",
        "lab.rel_a",
        ReleaseState::Uploading
    )
    .is_ok());
}

#[test]
fn the_epoch_and_versions_fail_closed_at_their_limits() {
    let spent = serving(None, 1, u64::MAX);
    assert_eq!(
        commit_live(
            &spent,
            u64::MAX,
            "lab.rel_a",
            "lab.rel_a",
            ReleaseState::Uploading
        ),
        Err(CommitLiveRefusal::Exhausted)
    );
    let mut full = serving(None, 1, 3);
    if let Some(h) = full.hosts.first_mut() {
        h.version = u64::MAX - 1;
    }
    assert_eq!(
        commit_live(&full, 3, "lab.rel_a", "lab.rel_a", ReleaseState::Uploading),
        Err(CommitLiveRefusal::Exhausted)
    );
    // An unpublish never fails: at the limit it pins the epoch, which no commit accepts again.
    let (down, _) = unpublish(&spent);
    assert_eq!(down.epoch, u64::MAX);
    assert_eq!(
        commit_live(
            &down,
            u64::MAX,
            "lab.rel_a",
            "lab.rel_a",
            ReleaseState::Uploading
        ),
        Err(CommitLiveRefusal::Exhausted)
    );
    let (down, _) = unpublish(&serving(Some("lab.rel_a"), 1, u64::MAX - 1));
    assert_eq!(down.epoch, u64::MAX);
    assert_eq!(scripts(&down), [None]);
    assert_eq!(
        rollback(&down, u64::MAX, true, "rel_rb", ReleaseState::Uploading),
        Err(RollbackRefusal::NotKept)
    );
}

#[test]
fn a_room_made_private_mid_publish_never_goes_live() {
    let started = 4;
    let state = serving(Some("lab.rel_old"), 1, started);
    let (after, delete) = unpublish(&state);
    assert_eq!(after.epoch, 5);
    assert_eq!(scripts(&after), [None]);
    assert_eq!(delete, ["lab.rel_old"]);
    assert_eq!(
        commit_live(
            &after,
            started,
            "lab.rel_new",
            "lab.rel_new",
            ReleaseState::Uploading
        ),
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
    let Ok((live, _)) = served_live(&serving(None, 2, 7), 7, "lab.rel_1") else {
        unreachable!("refused");
    };
    // An operator suspends the custom hostname, or its claim starts ending: the room clears and closes that host.
    let Some(cleared) = clear_host(&live, 1) else {
        unreachable!("no host");
    };
    // A release already uploading commits: the default host switches, the closed custom host stays at nothing.
    let Ok((second, mark)) = commit_live(
        &cleared,
        7,
        "lab.rel_2",
        "lab.rel_2",
        ReleaseState::Uploading,
    ) else {
        unreachable!("refused");
    };
    assert_eq!(scripts(&second), [Some("lab.rel_2"), None]);
    assert!(second.hosts.get(1).is_some_and(|h| h.closed));
    assert_eq!(mark.versions.get(1), Some(&None));
    // A set-back leaves it alone.
    let back = applied(&second, &mark, "lab.rel_2");
    assert_eq!(scripts(&back.state), [Some("lab.rel_1"), None]);
    assert_eq!(back.reverted, [0]);
    // Confirmed instead, the catch-up leaves it alone, and so does a rollback.
    let Ok(confirmed) = confirm_served(&second, &mark, "lab.rel_2") else {
        unreachable!("not confirmed");
    };
    assert_eq!(confirmed.caught_up, Vec::<usize>::new());
    assert_eq!(confirmed.state.kept_previous.as_deref(), Some("lab.rel_1"));
    let Ok((rolled, _)) = rollback(&confirmed.state, 7, true, "rel_rb", ReleaseState::Uploading)
    else {
        unreachable!("refused");
    };
    assert_eq!(scripts(&rolled), [Some("lab.rel_1"), None]);
    // Only a new claim, active at Cloudflare, opens it again, on the release last confirmed served.
    let Some(reopened) = open_host(&confirmed.state, 1) else {
        unreachable!("no host");
    };
    assert_eq!(scripts(&reopened), [Some("lab.rel_2"), Some("lab.rel_2")]);
    assert!(reopened.hosts.iter().all(|h| !h.closed));
    assert_eq!(open_host(&second, 2), None);
}

/// The first release confirmed served on the default host, with a closed custom host, then a second release committed
/// and waiting for its marker.
fn second_in_flight() -> (ServeState, CommitMark) {
    let Ok((live, _)) = served_live(&serving(None, 2, 4), 4, "lab.rel_1") else {
        unreachable!("refused");
    };
    let Some(closed) = clear_host(&live, 1) else {
        unreachable!("no host");
    };
    let Ok(second) = commit_live(
        &closed,
        4,
        "lab.rel_2",
        "lab.rel_2",
        ReleaseState::Uploading,
    ) else {
        unreachable!("refused");
    };
    second
}

#[test]
fn a_host_opened_mid_flight_catches_up_when_the_marker_comes_back() {
    let (second, mark) = second_in_flight();
    // Opened in the window: the release last confirmed, never the unconfirmed one.
    let Some(opened) = open_host(&second, 1) else {
        unreachable!("no host");
    };
    assert_eq!(scripts(&opened), [Some("lab.rel_2"), Some("lab.rel_1")]);
    // The marker comes back: the opened host moves to the confirmed release in the same decision.
    let Ok(confirmed) = confirm_served(&opened, &mark, "lab.rel_2") else {
        unreachable!("not confirmed");
    };
    assert_eq!(
        scripts(&confirmed.state),
        [Some("lab.rel_2"), Some("lab.rel_2")]
    );
    assert_eq!(confirmed.caught_up, [1]);
    assert_eq!(confirmed.state.kept_previous.as_deref(), Some("lab.rel_1"));
    // So a rollback switches every host back, and isn't refused as already live.
    let Ok((rolled, _)) = rollback(&confirmed.state, 4, true, "rel_rb", ReleaseState::Uploading)
    else {
        unreachable!("refused");
    };
    assert_eq!(scripts(&rolled), [Some("lab.rel_1"), Some("lab.rel_1")]);
    // A confirmation after an unpublish confirms nothing.
    let (down, _) = unpublish(&opened);
    assert_eq!(
        confirm_served(&down, &mark, "lab.rel_2"),
        Err(StaleCompletion)
    );
}

#[test]
fn a_host_opened_mid_flight_stays_on_the_confirmed_release_when_the_marker_fails() {
    let (second, mark) = second_in_flight();
    let Some(opened) = open_host(&second, 1) else {
        unreachable!("no host");
    };
    let back = applied(&opened, &mark, "lab.rel_2");
    assert_eq!(scripts(&back.state), [Some("lab.rel_1"), Some("lab.rel_1")]);
    assert_eq!(back.reverted, [0]);
    assert!(back.delete_script);
}

#[test]
fn a_host_opened_after_an_unpublish_serves_nothing() {
    let (second, _) = second_in_flight();
    let (down, delete) = unpublish(&second);
    // The unpublish takes the flight's mark from the state, so the release live before the commit is deleted too.
    assert!(delete.contains(&"lab.rel_1".to_owned()));
    assert!(delete.contains(&"lab.rel_2".to_owned()));
    let Some(opened) = open_host(&down, 1) else {
        unreachable!("no host");
    };
    assert_eq!(scripts(&opened), [None, None]);
    assert_eq!(confirmed_script(&down), None);
}

#[test]
fn a_host_opened_before_any_release_was_served_serves_nothing() {
    let state = serving(None, 2, 1);
    let Some(opened) = open_host(&state, 1) else {
        unreachable!("no host");
    };
    assert_eq!(scripts(&opened), [None, None]);
    // Nor during the very first release's flight.
    let Ok((first, mark)) =
        commit_live(&state, 1, "lab.rel_1", "lab.rel_1", ReleaseState::Uploading)
    else {
        unreachable!("refused");
    };
    let Some(mid) = open_host(&first, 1) else {
        unreachable!("no host");
    };
    assert_eq!(scripts(&mid), [Some("lab.rel_1"), None]);
    assert_eq!(confirmed_script(&first), None);
    let Ok(confirmed) = confirm_served(&first, &mark, "lab.rel_1") else {
        unreachable!("not confirmed");
    };
    assert_eq!(
        confirmed_script(&confirmed.state),
        Some("lab.rel_1".to_owned())
    );
}

#[test]
fn an_unpublish_keeps_closed_hosts_closed() {
    let Some(state) = clear_host(&serving(Some("lab.rel_1"), 2, 1), 1) else {
        unreachable!("no host");
    };
    let (down, _) = unpublish(&state);
    assert_eq!(
        down.hosts.iter().map(|h| h.closed).collect::<Vec<_>>(),
        [false, true]
    );
    // So a release committed after it, under the new epoch, still doesn't write to the closed host.
    let Ok((after, _)) = commit_live(
        &down,
        down.epoch,
        "lab.rel_2",
        "lab.rel_2",
        ReleaseState::Uploading,
    ) else {
        unreachable!("refused");
    };
    assert_eq!(scripts(&after), [Some("lab.rel_2"), None]);
}

#[test]
fn a_second_release_failing_after_the_first_is_live_leaves_the_first_serving() {
    let first = "lab.rel_1";
    let Ok((live, _)) = served_live(&serving(None, 1, 2), 2, first) else {
        unreachable!("first refused");
    };
    assert_eq!(scripts(&live), [Some(first)]);
    assert_eq!(
        next_state(ReleaseState::Uploading, ReleaseEvent::Fail),
        Ok(ReleaseState::Failed)
    );
    let Ok((second, mark)) =
        commit_live(&live, 2, "lab.rel_2", "lab.rel_2", ReleaseState::Uploading)
    else {
        unreachable!("second refused");
    };
    assert_eq!(
        marker_outcome(None, "rel_2", MARKER_WAIT_MS),
        MarkerOutcome::Failed
    );
    let back = applied(&second, &mark, "lab.rel_2");
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
    let Ok((live, mark)) = commit_live(
        &serving(Some("lab.rel_1"), 2, 3),
        3,
        "lab.rel_2",
        "lab.rel_2",
        ReleaseState::Uploading,
    ) else {
        unreachable!("refused");
    };
    // The custom host changed since the commit: here, opened again after a claim, still naming the failed script.
    let mut changed = live.clone();
    if let Some(h) = changed.hosts.get_mut(1) {
        h.version += 1;
    }
    let back = applied(&changed, &mark, "lab.rel_2");
    assert_eq!(back.reverted, [0]);
    assert_eq!(scripts(&back.state), [Some("lab.rel_1"), Some("lab.rel_2")]);
    // So its script is still served, and the caller mustn't delete it.
    assert!(!back.delete_script);
}

#[test]
fn a_set_back_needs_the_commits_epoch() {
    // Hand-built: the flight is this commit's, but the epoch moved while every version is still what it wrote. Nothing
    // is set back, and the flight ends.
    let mark = CommitMark {
        epoch: 8,
        versions: vec![Some(11)],
        before: vec![Some("lab.rel_1".into())],
    };
    let state = ServeState {
        epoch: 9,
        hosts: vec![host(Some("lab.rel_2"), 11)],
        kept_previous: None,
        in_flight: Some(InFlight {
            release_id: "lab.rel_2".into(),
            script: "lab.rel_2".into(),
            mark: mark.clone(),
        }),
    };
    let back = applied(&state, &mark, "lab.rel_2");
    assert_eq!(
        (back.state.epoch, &back.state.hosts),
        (state.epoch, &state.hosts)
    );
    assert!(back.reverted.is_empty());
    assert!(!back.delete_script);
    // The same with the epoch right sets it back.
    let same = CommitMark { epoch: 9, ..mark };
    let right = ServeState {
        in_flight: Some(InFlight {
            release_id: "lab.rel_2".into(),
            script: "lab.rel_2".into(),
            mark: same.clone(),
        }),
        ..state
    };
    assert_eq!(applied(&right, &same, "lab.rel_2").reverted, [0]);
}

#[test]
fn a_set_back_after_an_unpublish_changes_nothing() {
    let Ok((live, mark)) = commit_live(
        &serving(Some("lab.rel_1"), 2, 3),
        3,
        "lab.rel_2",
        "lab.rel_2",
        ReleaseState::Uploading,
    ) else {
        unreachable!("refused");
    };
    let (down, delete) = unpublish(&live);
    // The unpublish deletes the failed release's script and the one live before it, which sat only in the mark.
    assert_eq!(delete, ["lab.rel_1", "lab.rel_2"]);
    // The unpublish ended the flight: the set-back is stale, changes nothing and orders nothing deleted; the unpublish's
    // own list already holds the script.
    assert_eq!(set_back(&down, &mark, "lab.rel_2"), Err(StaleCompletion));
    assert_eq!(scripts(&down), [None, None]);
    let Some(cleared) = clear_host(&live, 1) else {
        unreachable!("no host");
    };
    assert_eq!(applied(&cleared, &mark, "lab.rel_2").reverted, [0]);
    // Another commit can't land in between: it is refused while this one is in flight.
    assert_eq!(
        commit_live(&live, 3, "lab.rel_3", "lab.rel_3", ReleaseState::Uploading),
        Err(CommitLiveRefusal::InFlight)
    );
    let short = CommitMark {
        versions: vec![],
        before: vec![],
        ..mark.clone()
    };
    // A mark that isn't the flight's is stale, and sets nothing back.
    assert_eq!(set_back(&live, &short, "lab.rel_2"), Err(StaleCompletion));
}

#[test]
fn a_late_or_duplicated_job_changes_nothing() {
    let state = serving(None, 1, 6);
    let (down, _) = unpublish(&state);
    assert_eq!(
        commit_live(
            &down,
            6,
            "lab.rel_late",
            "lab.rel_late",
            ReleaseState::Uploading
        ),
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
    let Ok((live, mark)) =
        commit_live(&state, 6, "lab.rel_a", "lab.rel_a", ReleaseState::Uploading)
    else {
        unreachable!("refused");
    };
    assert_eq!(
        commit_live(&live, 6, "lab.rel_a", "lab.rel_a", ReleaseState::Uploading),
        Ok((live.clone(), mark.clone()))
    );
    // Confirmed, then a newer release served: a late set-back of the first changes nothing.
    let Ok(confirmed) = confirm_served(&live, &mark, "lab.rel_a") else {
        unreachable!("not confirmed");
    };
    let Ok((newer, _)) = served_live(&confirmed.state, 6, "lab.rel_b") else {
        unreachable!("refused");
    };
    assert_eq!(set_back(&newer, &mark, "lab.rel_a"), Err(StaleCompletion));
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
    assert_eq!(
        rollback(&state, 9, true, "rel_rb", ReleaseState::Uploading),
        Err(RollbackRefusal::NotKept)
    );
    state.kept_previous = Some("lab.rel_1".into());
    assert_eq!(
        rollback(&state, 9, false, "rel_rb", ReleaseState::Uploading),
        Err(RollbackRefusal::NotKept)
    );
    assert_eq!(
        rollback(&state, 8, true, "rel_rb", ReleaseState::Uploading),
        Err(RollbackRefusal::Commit(CommitLiveRefusal::EpochMoved))
    );
    let Ok((back, mark)) = rollback(&state, 9, true, "rel_rb", ReleaseState::Uploading) else {
        unreachable!("refused");
    };
    assert_eq!(scripts(&back), [Some("lab.rel_1"), Some("lab.rel_1")]);
    assert_eq!(
        mark.before,
        [Some("lab.rel_2".to_owned()), Some("lab.rel_2".to_owned())]
    );
    let (down, _) = unpublish(&state);
    assert_eq!(down.kept_previous, None);
    assert_eq!(
        rollback(&down, down.epoch, true, "rel_rb", ReleaseState::Uploading),
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
    let (after, delete) = unpublish(&state);
    assert_eq!(after.epoch, 5);
    assert_eq!(scripts(&after), [None, None]);
    assert_eq!(versions(&after), [11, 12]);
    assert_eq!(after.kept_previous, None);
    assert_eq!(delete, ["lab.rel_1", "lab.rel_2"]);
    let (quiet, none) = unpublish(&serving(None, 1, 0));
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
        organization_may_provision: true,
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
    let cases: [(RecheckChange, RecheckFailure); 19] = [
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
            |r| r.organization_may_provision = false,
            RecheckFailure::ProvisioningNotDelegated,
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

// --- the organization's two facts, and the operator's release switch (decision 218) -------------------------------

#[test]
fn both_organization_facts_answer_release_not_delegated_and_keep_their_cause() {
    let commit = MERGED;
    let mut switch = open_recheck(&commit);
    switch.room.organization_may_release = false;
    let mut provisioning = open_recheck(&commit);
    provisioning.organization_may_provision = false;
    let by_switch = recheck(&switch);
    let by_provisioning = recheck(&provisioning);
    assert_eq!(
        by_switch,
        Err(RecheckFailure::Trigger(
            UnpublishTrigger::ReleaseTakenFromOrganization
        ))
    );
    assert_eq!(
        by_provisioning,
        Err(RecheckFailure::ProvisioningNotDelegated)
    );
    // The same code on the wire, and a cause of each one's own for the audit record and the findings.
    for (failure, cause) in [
        (by_switch, NotDelegatedCause::ReleaseSwitch),
        (by_provisioning, NotDelegatedCause::ProvisioningDelegation),
    ] {
        let Err(failure) = failure else {
            unreachable!("{cause:?} must refuse")
        };
        assert_eq!(failure.code(), "release_not_delegated");
        assert_eq!(failure.not_delegated_cause(), Some(cause));
    }
    assert_eq!(NotDelegatedCause::ReleaseSwitch.code(), "release_switch");
    assert_eq!(
        NotDelegatedCause::ProvisioningDelegation.code(),
        "provisioning_delegation"
    );
    assert_ne!(
        NotDelegatedCause::ReleaseSwitch.code(),
        NotDelegatedCause::ProvisioningDelegation.code()
    );
    // Every other failure has no such cause, the unpublish triggers' own included.
    for trigger in UnpublishTrigger::ALL {
        let expected = (trigger == UnpublishTrigger::ReleaseTakenFromOrganization)
            .then_some(NotDelegatedCause::ReleaseSwitch);
        assert_eq!(
            RecheckFailure::Trigger(trigger).not_delegated_cause(),
            expected,
            "{trigger:?}"
        );
    }
    for other in [
        RecheckFailure::DomainStopped,
        RecheckFailure::ConfigChanged,
        RecheckFailure::RequesterLostAuthority,
        RecheckFailure::ApproverLostAuthority,
        RecheckFailure::ReviewerRuleChanged,
        RecheckFailure::Commit(CommitRefusal::NotReleasable),
        RecheckFailure::EpochMoved,
    ] {
        assert_eq!(other.not_delegated_cause(), None, "{other:?}");
    }
}

#[test]
fn the_provisioning_delegation_refuses_and_never_unpublishes() {
    // It isn't one of the room's facts, so no set of them can make it a trigger: a room whose organization lost only
    // the delegation keeps its app up.
    let facts = RoomReleaseFacts::OPEN;
    assert!(unpublish_triggers(&facts).is_empty());
    let commit = MERGED;
    let mut r = open_recheck(&commit);
    r.organization_may_provision = false;
    assert_eq!(recheck(&r), Err(RecheckFailure::ProvisioningNotDelegated));
    assert!(unpublish_triggers(&r.room).is_empty());
    // The switch is checked first: both taken is the switch's, which unpublishes.
    r.room.organization_may_release = false;
    assert_eq!(
        recheck(&r),
        Err(RecheckFailure::Trigger(
            UnpublishTrigger::ReleaseTakenFromOrganization
        ))
    );
    // And the organization gone comes before both.
    r.room.organization_exists = false;
    assert_eq!(
        recheck(&r),
        Err(RecheckFailure::Trigger(
            UnpublishTrigger::OrganizationDeleted
        ))
    );
}

const fn sw(granted: bool, generation: u64, last_take: u64) -> ReleaseSwitch {
    ReleaseSwitch {
        granted,
        generation,
        last_take,
    }
}

#[test]
fn every_set_of_the_switch_raises_its_generation_and_a_take_is_the_last_take() {
    assert_eq!(ReleaseSwitch::UNSET, sw(true, 0, 0));
    assert_eq!(ReleaseSwitch::UNSET.set(false), Some(sw(false, 1, 1)));
    // Setting it to what it is still raises the generation, so asking again tells every room again; a repeated take
    // is the new last take.
    assert_eq!(sw(false, 1, 1).set(false), Some(sw(false, 2, 2)));
    // A give-back keeps the last take.
    assert_eq!(sw(false, 2, 2).set(true), Some(sw(true, 3, 2)));
    assert_eq!(sw(true, 3, 2).set(true), Some(sw(true, 4, 2)));
    assert_eq!(ReleaseSwitch::UNSET.set(true), Some(sw(true, 1, 0)));
    assert_eq!(
        sw(true, u64::MAX - 1, 3).set(false),
        Some(sw(false, u64::MAX, u64::MAX))
    );
    for granted in [true, false] {
        assert_eq!(sw(true, u64::MAX, 3).set(granted), None, "{granted}");
        assert_eq!(
            sw(false, u64::MAX, u64::MAX).set(granted),
            None,
            "{granted}"
        );
    }
}

#[test]
fn a_switch_is_well_formed_only_when_its_last_take_agrees() {
    for good in [
        ReleaseSwitch::UNSET,
        sw(false, 1, 1),
        sw(true, 2, 1),
        sw(true, 9, 0),
        sw(false, u64::MAX, u64::MAX),
    ] {
        assert!(good.well_formed(), "{good:?}");
    }
    // A last take after the current generation; taken but not taken now; taken at generation 0, which no set makes;
    // held with the last take now; held, unset, with a take.
    for bad in [
        sw(true, 1, 2),
        sw(false, 3, 2),
        sw(false, 3, 0),
        sw(false, 0, 0),
        sw(true, 2, 2),
        sw(true, 0, 1),
    ] {
        assert!(!bad.well_formed(), "{bad:?}");
        assert_eq!(
            apply_release_switch(ReleaseSwitch::UNSET, bad),
            SwitchApplied::Refused,
            "{bad:?}"
        );
    }
    // Every switch a sequence of sets makes is well formed.
    let mut s = ReleaseSwitch::UNSET;
    for step in 0..40u32 {
        let Some(next) = s.set(step % 3 == 1) else {
            unreachable!("forty sets fit")
        };
        s = next;
        assert!(s.well_formed(), "{s:?}");
    }
}

#[test]
fn a_room_applies_only_a_newer_answer_and_a_give_back_with_no_take_since_restores_nothing() {
    let applied = sw(true, 4, 2);
    for seen in [
        sw(true, 4, 2),
        sw(true, 3, 2),
        sw(false, 2, 2),
        sw(true, 0, 0),
    ] {
        assert_eq!(
            apply_release_switch(applied, seen),
            SwitchApplied::Stale,
            "{seen:?}"
        );
    }
    // Newer, with no take since generation 4: only recorded.
    assert_eq!(
        apply_release_switch(applied, sw(true, 5, 2)),
        SwitchApplied::Record
    );
    assert_eq!(
        apply_release_switch(applied, sw(true, 9, 4)),
        SwitchApplied::Record
    );
    // A take since generation 4, current or already given back: unpublished.
    assert_eq!(
        apply_release_switch(applied, sw(false, 5, 5)),
        SwitchApplied::Unpublish
    );
    assert_eq!(
        apply_release_switch(applied, sw(true, 6, 5)),
        SwitchApplied::Unpublish
    );
    assert_eq!(
        apply_release_switch(applied, sw(false, u64::MAX, u64::MAX)),
        SwitchApplied::Unpublish
    );
    // After a take, the same notice again is acknowledged and does nothing; a give-back after it only records.
    let taken = sw(false, 5, 5);
    assert_eq!(apply_release_switch(taken, taken), SwitchApplied::Stale);
    assert_eq!(
        apply_release_switch(taken, sw(true, 6, 5)),
        SwitchApplied::Record
    );
    assert_eq!(
        apply_release_switch(ReleaseSwitch::UNSET, ReleaseSwitch::UNSET),
        SwitchApplied::Stale
    );
    // An answer at the generation the room applied that disagrees with it is not newer, whichever way it disagrees: it
    // changes nothing, and a taken one doesn't unpublish.
    assert_eq!(
        apply_release_switch(sw(true, 4, 2), sw(false, 4, 4)),
        SwitchApplied::Stale
    );
    assert_eq!(
        apply_release_switch(sw(false, 4, 4), sw(true, 4, 2)),
        SwitchApplied::Stale
    );
}

#[test]
fn a_room_whose_applied_switch_is_malformed_decides_nothing() {
    // Whatever it hears, newer or not, taken or held, it is refused, never applied, so nothing records or unpublishes
    // on a value the room can't compare against.
    for applied in [
        sw(true, 1, 2),
        sw(false, 3, 2),
        sw(false, 0, 0),
        sw(true, 2, 2),
    ] {
        for seen in [
            ReleaseSwitch::UNSET,
            sw(false, 1, 1),
            sw(true, 5, 1),
            sw(false, 9, 9),
            applied,
        ] {
            assert_eq!(
                apply_release_switch(applied, seen),
                SwitchApplied::Refused,
                "{applied:?} {seen:?}"
            );
        }
        assert_eq!(
            release_switch_now(applied, Some(sw(false, 9, 9))),
            None,
            "{applied:?}"
        );
    }
}

/// A room as the switch's answers leave it: what it applied, whether its app is still up, and its epoch.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct SwitchRoom {
    applied: ReleaseSwitch,
    up: bool,
    epoch: u64,
}

/// What the room does with one answer, as `apply_release_switch` says. This models the room's transaction; PR C shows
/// it in the room itself.
fn hear(room: SwitchRoom, seen: ReleaseSwitch) -> SwitchRoom {
    match apply_release_switch(room.applied, seen) {
        SwitchApplied::Stale | SwitchApplied::Refused => room,
        // Restores nothing: an app that was taken down stays down.
        SwitchApplied::Record => SwitchRoom {
            applied: seen,
            ..room
        },
        SwitchApplied::Unpublish => SwitchRoom {
            applied: seen,
            up: false,
            epoch: room.epoch + 1,
        },
    }
}

/// The switch after each of an operator's sets, from unset: `[s1, s2, …]`.
fn switches(takes: &[bool]) -> Vec<ReleaseSwitch> {
    let mut s = ReleaseSwitch::UNSET;
    takes
        .iter()
        .map(|take| {
            let Some(next) = s.set(!take) else {
                unreachable!("a few sets fit")
            };
            s = next;
            s
        })
        .collect()
}

/// Every ordering of every subset of `0..n`, the empty one included.
fn arrivals(n: usize) -> Vec<Vec<usize>> {
    fn grow(prefix: &mut Vec<usize>, n: usize, out: &mut Vec<Vec<usize>>) {
        out.push(prefix.clone());
        for i in 0..n {
            if !prefix.contains(&i) {
                prefix.push(i);
                grow(prefix, n, out);
                prefix.pop();
            }
        }
    }
    let mut out = Vec::new();
    grow(&mut Vec::new(), n, &mut out);
    out
}

#[test]
fn whatever_arrives_in_whatever_order_a_room_comes_down_exactly_when_a_take_happened_after_it_started(
) {
    // Every sequence of up to four takes and gives; a room that started from unset or from the switch after any set,
    // as a room made then would (`start_for_room`); and that hears any subset of the sets in any order, each one
    // possibly twice. The expected outcome is computed from the operator's acts alone, never from `last_take`.
    let mut cases = 0u32;
    for len in 1..=4usize {
        for bits in 0..(1u32 << len) {
            let takes: Vec<bool> = (0..len).map(|i| bits & (1 << i) != 0).collect();
            let sets = switches(&takes);
            for start_at in 0..=len {
                let start_switch = if start_at == 0 {
                    ReleaseSwitch::UNSET
                } else {
                    ReleaseSwitch::start_for_room(sets.get(start_at - 1).copied())
                };
                let start = SwitchRoom {
                    applied: start_switch,
                    up: true,
                    epoch: 7,
                };
                for order in arrivals(len) {
                    for repeat in 0..=order.len() {
                        let mut room = start;
                        for (k, &i) in order.iter().enumerate() {
                            let Some(seen) = sets.get(i) else {
                                unreachable!("an index of the sets")
                            };
                            room = hear(room, *seen);
                            if k == repeat {
                                room = hear(room, *seen);
                            }
                        }
                        // The newest set heard that is newer than where the room started.
                        let newest = order.iter().copied().filter(|&i| i + 1 > start_at).max();
                        let label =
                            format!("{takes:?} start {start_at} heard {order:?} twice {repeat}");
                        match newest {
                            None => assert_eq!(room, start, "{label}"),
                            Some(newest) => {
                                let took = (start_at..=newest).any(|i| takes.get(i) == Some(&true));
                                assert_eq!(sets.get(newest), Some(&room.applied), "{label}");
                                assert_eq!(room.up, !took, "{label}");
                                assert_eq!(room.epoch > start.epoch, took, "{label}");
                                // The same as hearing only the newest: no other notice changes the outcome.
                                let only = hear(start, room.applied);
                                assert_eq!(
                                    (only.applied, only.up),
                                    (room.applied, room.up),
                                    "{label}"
                                );
                            }
                        }
                        cases += 1;
                    }
                }
            }
        }
    }
    assert!(cases > 1_000, "{cases} cases");
}

#[test]
fn a_room_that_hears_only_the_last_give_back_still_comes_down() {
    // Take, then give: a room whose take notice is late, or that isn't in the organization's list and reads the
    // switch only after the give-back.
    let sets = switches(&[true, false]);
    let start = SwitchRoom {
        applied: ReleaseSwitch::UNSET,
        up: true,
        epoch: 7,
    };
    let (Some(take), Some(give)) = (sets.first().copied(), sets.get(1).copied()) else {
        unreachable!("two sets")
    };
    assert_eq!(give, sw(true, 2, 1));
    let room = hear(start, give);
    assert!(!room.up);
    assert_eq!(room.applied, give);
    // The late take is then stale and changes nothing more.
    assert_eq!(hear(room, take), room);
    // In order, the same end.
    assert_eq!(
        hear(hear(start, take), give),
        SwitchRoom { epoch: 8, ..room }
    );
    // Take, give, take, give: hearing only the last give at each point brings the room down once a take was missed.
    let sets = switches(&[true, false, true, false]);
    for after in 0..sets.len() {
        let Some(at) = sets.get(after).copied() else {
            unreachable!("an index of the sets")
        };
        let room = SwitchRoom {
            applied: at,
            up: true,
            epoch: 7,
        };
        let Some(last) = sets.last().copied() else {
            unreachable!("four sets")
        };
        let heard = hear(room, last);
        // A take after `after` exists unless the room already applied the last set.
        assert_eq!(
            heard.up,
            after + 1 == sets.len() || after == 2,
            "after {after}"
        );
    }
}

#[test]
fn a_room_made_after_a_take_back_has_nothing_to_unpublish_and_is_refused() {
    // The room is made while release is taken at generation 1, and starts from what it read then.
    let taken = sw(false, 1, 1);
    let applied = ReleaseSwitch::start_for_room(Some(taken));
    assert_eq!(applied, taken);
    // The take before it existed is stale for it, so it has nothing to unpublish, and the recheck refuses.
    assert_eq!(apply_release_switch(applied, taken), SwitchApplied::Stale);
    let now = release_switch_now(applied, Some(taken));
    assert_eq!(now, Some(taken));
    let commit = MERGED;
    let mut r = open_recheck(&commit);
    r.room.organization_may_release = now.is_some_and(|s| s.granted);
    assert_eq!(
        recheck(&r),
        Err(RecheckFailure::Trigger(
            UnpublishTrigger::ReleaseTakenFromOrganization
        ))
    );
    // A give-back later only records: nothing was taken after the room began.
    assert_eq!(
        apply_release_switch(applied, sw(true, 2, 1)),
        SwitchApplied::Record
    );
    // A room that couldn't read the switch at creation, or read a malformed one, starts unset and fails closed: the
    // take before it is then newer, so it unpublishes, which with nothing up deletes nothing and raises the epoch.
    for unread in [None, Some(sw(false, 3, 0))] {
        let start = ReleaseSwitch::start_for_room(unread);
        assert_eq!(start, ReleaseSwitch::UNSET, "{unread:?}");
        assert_eq!(apply_release_switch(start, taken), SwitchApplied::Unpublish);
    }
    let (after, delete) = unpublish(&serving(None, 1, 0));
    assert!(delete.is_empty(), "nothing was up, so nothing is deleted");
    assert_eq!(scripts(&after), [None]);
    assert_eq!(
        after.epoch, 1,
        "the epoch still goes up, so nothing in flight goes live after it"
    );
}

#[test]
fn the_recheck_takes_the_newer_switch_and_an_unread_or_contradictory_one_is_undecided() {
    let applied = sw(false, 3, 3);
    assert_eq!(release_switch_now(applied, None), None);
    assert_eq!(release_switch_now(ReleaseSwitch::UNSET, None), None);
    // A reply overtaken by a newer notice gives way to the notice.
    assert_eq!(
        release_switch_now(applied, Some(sw(true, 2, 1))),
        Some(applied)
    );
    assert_eq!(
        release_switch_now(applied, Some(ReleaseSwitch::UNSET)),
        Some(applied)
    );
    assert_eq!(release_switch_now(applied, Some(applied)), Some(applied));
    assert_eq!(
        release_switch_now(applied, Some(sw(true, 4, 3))),
        Some(sw(true, 4, 3))
    );
    // The same generation, saying different things, can't both be the organization's: undecided, either way round.
    assert_eq!(release_switch_now(applied, Some(sw(true, 3, 2))), None);
    assert_eq!(release_switch_now(sw(true, 3, 2), Some(applied)), None);
    assert_eq!(
        release_switch_now(sw(true, 3, 1), Some(sw(true, 3, 2))),
        None
    );
    // A malformed answer, or a malformed applied switch, is undecided too.
    assert_eq!(release_switch_now(applied, Some(sw(false, 4, 0))), None);
    assert_eq!(
        release_switch_now(sw(false, 3, 0), Some(sw(true, 4, 3))),
        None
    );
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

#[test]
fn the_read_budget_says_when_a_release_would_fit() {
    let hour = READ_WINDOW_MS;
    // Nothing held: a full-size release fits, and so does the budget exactly.
    assert_eq!(read_budget_wait(&[], 302, NOW), Ok(()));
    assert_eq!(
        read_budget_wait(&[], MAX_RELEASE_READS_PER_HOUR, NOW),
        Ok(())
    );
    // Past the budget alone, it never fits.
    assert_eq!(
        read_budget_wait(&[], MAX_RELEASE_READS_PER_HOUR + 1, NOW),
        Err(None)
    );
    // Nine full-size releases held: a tenth waits until the oldest leaves the hour, in any order given.
    let nine: Vec<(i64, u32)> = (0..9).map(|n| (NOW - 9_000 + n * 1_000, 302)).collect();
    assert_eq!(
        read_budget_wait(&nine, 302, NOW),
        Err(Some(NOW - 9_000 + hour))
    );
    let mut shuffled = nine.clone();
    shuffled.reverse();
    assert_eq!(
        read_budget_wait(&shuffled, 302, NOW),
        Err(Some(NOW - 9_000 + hour))
    );
    // A small one still fits beside them: 9 x 302 = 2,718, and 282 more is exactly 3,000.
    assert_eq!(read_budget_wait(&nine, 282, NOW), Ok(()));
    assert_eq!(
        read_budget_wait(&nine, 283, NOW),
        Err(Some(NOW - 9_000 + hour))
    );
    // The hour's edge, to the millisecond: a reservation made exactly an hour ago no longer counts, one a millisecond
    // later still does.
    let full = [(NOW - hour + 1, MAX_RELEASE_READS_PER_HOUR)];
    assert_eq!(read_budget_wait(&full, 1, NOW), Err(Some(NOW + 1)));
    assert_eq!(
        read_budget_wait(&[(NOW - hour, MAX_RELEASE_READS_PER_HOUR)], 1, NOW),
        Ok(())
    );
    // At the time it was told, it fits.
    assert_eq!(read_budget_wait(&full, 1, NOW + 1), Ok(()));
    // It waits for as many of the oldest as it takes: one must leave for 600 reads, two for 1,001.
    let held = [(NOW - 100, 1_000), (NOW - 300, 1_000), (NOW - 200, 1_000)];
    assert_eq!(
        read_budget_wait(&held, 600, NOW),
        Err(Some(NOW - 300 + hour))
    );
    assert_eq!(
        read_budget_wait(&held, 1_001, NOW),
        Err(Some(NOW - 200 + hour))
    );
    assert_eq!(read_budget_wait(&held, 1_001, NOW - 200 + hour), Ok(()));
    assert_eq!(
        read_budget_wait(&held, 1_001, NOW - 201 + hour),
        Err(Some(NOW - 200 + hour))
    );
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

#[test]
fn a_late_success_after_a_set_back_confirms_nothing() {
    // Default A; B commits; a host opens; B's marker fails and B is set back and ordered deleted.
    let (second, mark) = second_in_flight();
    let Some(opened) = open_host(&second, 1) else {
        unreachable!("no host");
    };
    let back = applied(&opened, &mark, "lab.rel_2");
    assert!(back.delete_script);
    assert_eq!(scripts(&back.state), [Some("lab.rel_1"), Some("lab.rel_1")]);
    // A late or duplicated success: nothing is confirmed, so no host goes to the script being deleted.
    assert_eq!(
        confirm_served(&back.state, &mark, "lab.rel_2"),
        Err(StaleCompletion)
    );
}

#[test]
fn a_stale_success_after_a_later_release_confirms_nothing() {
    // B served, then C served; then B's old marker success arrives.
    let Ok((b, mark_b)) = served_live(&serving(Some("lab.rel_1"), 1, 2), 2, "lab.rel_2") else {
        unreachable!("refused");
    };
    let Ok((c, _)) = served_live(&b, 2, "lab.rel_3") else {
        unreachable!("refused");
    };
    assert_eq!(scripts(&c), [Some("lab.rel_3")]);
    assert_eq!(
        confirm_served(&c, &mark_b, "lab.rel_2"),
        Err(StaleCompletion)
    );
}

#[test]
fn a_repeated_confirmation_changes_nothing_more() {
    let (second, mark) = second_in_flight();
    let Some(opened) = open_host(&second, 1) else {
        unreachable!("no host");
    };
    let Ok(first) = confirm_served(&opened, &mark, "lab.rel_2") else {
        unreachable!("not confirmed");
    };
    // The flight ended with the first: a repeat is stale, and changes nothing.
    assert_eq!(
        confirm_served(&first.state, &mark, "lab.rel_2"),
        Err(StaleCompletion)
    );
    assert_eq!(
        set_back(&first.state, &mark, "lab.rel_2"),
        Err(StaleCompletion)
    );
}

#[test]
fn one_release_in_flight_at_a_time_enforced_in_core() {
    let (second, mark) = second_in_flight();
    assert!(second.in_flight.is_some());
    // A second commit and a rollback are refused while the marker is awaited.
    assert_eq!(
        commit_live(
            &second,
            4,
            "lab.rel_3",
            "lab.rel_3",
            ReleaseState::Uploading
        ),
        Err(CommitLiveRefusal::InFlight)
    );
    let mut kept = second.clone();
    kept.kept_previous = Some("lab.rel_0".into());
    assert_eq!(
        rollback(&kept, 4, true, "rel_rb", ReleaseState::Uploading),
        Err(RollbackRefusal::Commit(CommitLiveRefusal::InFlight))
    );
    assert_eq!(CommitLiveRefusal::InFlight.code(), "release_in_flight");
    // Each way the flight ends clears it.
    let Ok(confirmed) = confirm_served(&second, &mark, "lab.rel_2") else {
        unreachable!("not confirmed");
    };
    assert!(confirmed.state.in_flight.is_none());
    assert!(commit_live(
        &confirmed.state,
        4,
        "lab.rel_3",
        "lab.rel_3",
        ReleaseState::Uploading
    )
    .is_ok());
    let back = applied(&second, &mark, "lab.rel_2");
    assert!(back.state.in_flight.is_none());
    assert!(commit_live(
        &back.state,
        4,
        "lab.rel_3",
        "lab.rel_3",
        ReleaseState::Uploading
    )
    .is_ok());
    let (down, _) = unpublish(&second);
    assert!(down.in_flight.is_none());
    assert!(commit_live(
        &down,
        down.epoch,
        "lab.rel_3",
        "lab.rel_3",
        ReleaseState::Uploading
    )
    .is_ok());
}

#[test]
fn a_failed_rollback_never_orders_the_kept_script_deleted() {
    // B served with A kept; a rollback to A commits; its marker fails.
    let Ok((a, _)) = served_live(&serving(None, 1, 3), 3, "lab.rel_1") else {
        unreachable!("refused");
    };
    let Ok((b, _)) = served_live(&a, 3, "lab.rel_2") else {
        unreachable!("refused");
    };
    assert_eq!(b.kept_previous.as_deref(), Some("lab.rel_1"));
    let Ok((rolled, mark)) = rollback(&b, 3, true, "rel_rb", ReleaseState::Uploading) else {
        unreachable!("refused");
    };
    let back = applied(&rolled, &mark, "lab.rel_1");
    assert_eq!(scripts(&back.state), [Some("lab.rel_2")]);
    // A is no longer served, but it is still the kept script, so it isn't deleted.
    assert_eq!(back.state.kept_previous.as_deref(), Some("lab.rel_1"));
    assert!(!back.delete_script);
}

#[test]
fn opening_a_host_and_catching_it_up_each_move_its_version() {
    let (second, mark) = second_in_flight();
    let before = second.hosts.get(1).map(|h| h.version);
    let Some(opened) = open_host(&second, 1) else {
        unreachable!("no host");
    };
    let opened_version = opened.hosts.get(1).map(|h| h.version);
    assert_eq!(opened_version, before.map(|v| v + 1));
    let Ok(confirmed) = confirm_served(&opened, &mark, "lab.rel_2") else {
        unreachable!("not confirmed");
    };
    assert_eq!(
        confirmed.state.hosts.get(1).map(|h| h.version),
        opened_version.map(|v| v + 1)
    );
    // The default host, already on the release, keeps its version.
    assert_eq!(
        confirmed.state.hosts.first().map(|h| h.version),
        opened.hosts.first().map(|h| h.version)
    );
}

#[test]
fn a_duplicated_failure_never_frees_a_newer_flight() {
    // The review's six steps. Default A; commit B; B's marker fails and B is set back to A.
    let Ok((a, _)) = served_live(&serving(None, 1, 5), 5, "lab.rel_a") else {
        unreachable!("refused");
    };
    let Ok((b, mark_b)) = commit_live(&a, 5, "lab.rel_b", "lab.rel_b", ReleaseState::Uploading)
    else {
        unreachable!("refused");
    };
    let back_b = applied(&b, &mark_b, "lab.rel_b");
    assert_eq!(scripts(&back_b.state), [Some("lab.rel_a")]);
    assert!(back_b.state.in_flight.is_none());
    // C commits: it is the flight now.
    let Ok((c, mark_c)) = commit_live(
        &back_b.state,
        5,
        "lab.rel_c",
        "lab.rel_c",
        ReleaseState::Uploading,
    ) else {
        unreachable!("refused");
    };
    // A duplicated failure for B arrives: stale. Nothing changes, and C's flight stays.
    assert_eq!(set_back(&c, &mark_b, "lab.rel_b"), Err(StaleCompletion));
    let dup = c.clone();
    // So D is refused while C flies, and can't record an unconfirmed C as its `before`.
    assert_eq!(
        commit_live(&dup, 5, "lab.rel_d", "lab.rel_d", ReleaseState::Uploading),
        Err(CommitLiveRefusal::InFlight)
    );
    // C's marker fails: back to A, and C may be deleted. Then D commits on A, the confirmed release.
    let back_c = applied(&dup, &mark_c, "lab.rel_c");
    assert_eq!(scripts(&back_c.state), [Some("lab.rel_a")]);
    assert!(back_c.delete_script);
    let Ok((_, mark_d)) = commit_live(
        &back_c.state,
        5,
        "lab.rel_d",
        "lab.rel_d",
        ReleaseState::Uploading,
    ) else {
        unreachable!("refused");
    };
    assert_eq!(mark_d.before, [Some("lab.rel_a".to_owned())]);
}

#[test]
fn a_stale_success_during_a_rollback_to_the_same_release_confirms_nothing() {
    // B served (its mark kept by a late job), then C served with B kept; a rollback to B is in flight.
    let Ok((b, mark_b)) = served_live(&serving(Some("lab.rel_a"), 1, 2), 2, "lab.rel_b") else {
        unreachable!("refused");
    };
    let Ok((c, _)) = served_live(&b, 2, "lab.rel_c") else {
        unreachable!("refused");
    };
    let Ok((rolling, mark_r)) = rollback(&c, 2, true, "rel_rb", ReleaseState::Uploading) else {
        unreachable!("refused");
    };
    assert_eq!(scripts(&rolling), [Some("lab.rel_b")]);
    // B's old success arrives, naming the same script as the rollback: it isn't the flight's mark, so it is stale.
    assert_eq!(
        confirm_served(&rolling, &mark_b, "lab.rel_b"),
        Err(StaleCompletion)
    );
    assert!(rolling.in_flight.is_some());
    // The rollback's own success confirms it.
    assert!(confirm_served(&rolling, &mark_r, "lab.rel_b").is_ok());
}

#[test]
fn clearing_or_opening_a_host_mid_flight_leaves_the_flight_alone() {
    let (second, mark) = second_in_flight();
    let flight = second.in_flight.clone();
    assert!(flight.is_some());
    let Some(opened) = open_host(&second, 1) else {
        unreachable!("no host");
    };
    assert_eq!(opened.in_flight, flight);
    let Some(cleared) = clear_host(&opened, 1) else {
        unreachable!("no host");
    };
    assert_eq!(cleared.in_flight, flight);
    assert!(confirm_served(&cleared, &mark, "lab.rel_2").is_ok());
}

#[test]
fn a_retried_commit_is_replayed_and_never_told_to_fail() {
    let state = serving(Some("lab.rel_a"), 2, 3);
    let first = commit_live(&state, 3, "lab.rel_b", "lab.rel_b", ReleaseState::Uploading);
    let Ok((committed, mark)) = first.clone() else {
        unreachable!("refused");
    };
    // Asked again by the same record under the flight's epoch, the same commit gets the same answer; under another
    // epoch it is refused, since a retry checks the epoch too.
    assert_eq!(
        commit_live(
            &committed,
            3,
            "lab.rel_b",
            "lab.rel_b",
            ReleaseState::Uploading
        ),
        first
    );
    assert_eq!(
        commit_live(&committed, 3, "lab.rel_b", "lab.rel_b", ReleaseState::Live),
        first
    );
    assert_eq!(
        commit_live(
            &committed,
            2,
            "lab.rel_b",
            "lab.rel_b",
            ReleaseState::Uploading
        ),
        Err(CommitLiveRefusal::EpochMoved)
    );
    // A rollback is refused while anything is in flight.
    let mut kept = committed.clone();
    kept.kept_previous = Some("lab.rel_a".into());
    assert_eq!(
        rollback(&kept, 3, true, "rel_rb", ReleaseState::Uploading),
        Err(RollbackRefusal::Commit(CommitLiveRefusal::InFlight))
    );
    assert!(confirm_served(&committed, &mark, "lab.rel_b").is_ok());
}

/// Two gaps the mutation pass on PR #313 left open, closed here: a retry of the flight's own commit under a HIGHER
/// epoch than the flight's is refused as an epoch that moved, so the comparison is `!=` and never `>`; and the flight's
/// own release asking for a DIFFERENT script is refused as a flight in the way, never replayed as its own.
#[test]
fn a_retry_under_a_higher_epoch_and_the_same_release_with_another_script_are_both_refused() {
    let state = serving(Some("lab.rel_a"), 2, 3);
    let Ok((committed, mark)) =
        commit_live(&state, 3, "lab.rel_b", "lab.rel_b", ReleaseState::Uploading)
    else {
        unreachable!("refused");
    };
    for release in [ReleaseState::Uploading, ReleaseState::Live] {
        // The same record and the same script, under an epoch above the flight's: not a replay.
        assert_eq!(
            commit_live(&committed, 4, "lab.rel_b", "lab.rel_b", release),
            Err(CommitLiveRefusal::EpochMoved)
        );
        assert_eq!(
            commit_live(&committed, u64::MAX, "lab.rel_b", "lab.rel_b", release),
            Err(CommitLiveRefusal::EpochMoved)
        );
        // The flight's own release, under the flight's epoch, asking for another script: never its replay.
        assert_eq!(
            commit_live(&committed, 3, "lab.rel_c", "lab.rel_b", release),
            Err(CommitLiveRefusal::InFlight)
        );
    }
    // Neither refusal changed anything: the flight is still the first commit's, and it completes.
    assert!(confirm_served(&committed, &mark, "lab.rel_b").is_ok());
}

#[test]
fn a_release_that_ended_never_goes_live_again() {
    // B commits, its marker fails, and it is set back; its record is now failed.
    let Ok((a, _)) = served_live(&serving(None, 1, 2), 2, "lab.rel_a") else {
        unreachable!("refused");
    };
    let Ok((b, mark_b)) = commit_live(&a, 2, "lab.rel_b", "lab.rel_b", ReleaseState::Uploading)
    else {
        unreachable!("refused");
    };
    let back = applied(&b, &mark_b, "lab.rel_b");
    assert!(back.delete_script);
    let failed = next_state(ReleaseState::Live, ReleaseEvent::Fail).unwrap_or(ReleaseState::Live);
    // The same release asked again is refused by core itself, so no host goes to the script being deleted.
    assert_eq!(
        commit_live(&back.state, 2, "lab.rel_b", "lab.rel_b", failed),
        Err(CommitLiveRefusal::ReleaseEnded)
    );
    for ended in [
        ReleaseState::Failed,
        ReleaseState::Declined,
        ReleaseState::Replaced,
        ReleaseState::Unpublished,
    ] {
        assert_eq!(
            commit_live(&back.state, 2, "lab.rel_b", "lab.rel_b", ended),
            Err(CommitLiveRefusal::ReleaseEnded),
            "{ended:?}"
        );
    }
    for early in [
        ReleaseState::AwaitingApproval,
        ReleaseState::Queued,
        ReleaseState::Uncertain,
        ReleaseState::Served,
        ReleaseState::Live,
    ] {
        assert_eq!(
            commit_live(&back.state, 2, "lab.rel_c", "lab.rel_c", early),
            Err(CommitLiveRefusal::ReleaseNotUploading),
            "{early:?}"
        );
    }
    assert_eq!(CommitLiveRefusal::ReleaseEnded.code(), "release_ended");
    assert_eq!(
        CommitLiveRefusal::ReleaseNotUploading.code(),
        "release_not_uploading"
    );
    // A rollback is refused the same way.
    let Ok((c, _)) = served_live(&back.state, 2, "lab.rel_c") else {
        unreachable!("refused");
    };
    assert_eq!(
        rollback(&c, 2, true, "rel_rb", ReleaseState::Failed),
        Err(RollbackRefusal::Commit(CommitLiveRefusal::ReleaseEnded))
    );
}

#[test]
fn the_default_host_is_never_cleared() {
    let (second, mark) = second_in_flight();
    assert_eq!(clear_host(&second, 0), None);
    // So the flight's own confirmation still finds the default host as it wrote it.
    assert!(confirm_served(&second, &mark, "lab.rel_2").is_ok());
}

#[test]
fn a_retried_rollback_is_replayed_and_a_rollback_is_refused_during_another_flight() {
    let Ok((a, _)) = served_live(&serving(None, 1, 3), 3, "lab.rel_a") else {
        unreachable!("refused");
    };
    let Ok((b, _)) = served_live(&a, 3, "lab.rel_b") else {
        unreachable!("refused");
    };
    let first = rollback(&b, 3, true, "rel_rb", ReleaseState::Uploading);
    let Ok((rolling, _)) = first.clone() else {
        unreachable!("refused");
    };
    // The same rollback asked again, its record live, gets its first answer.
    assert_eq!(
        rollback(&rolling, 3, true, "rel_rb", ReleaseState::Live),
        first
    );
    // During another release's flight, a rollback is refused.
    let Ok((c_flight, _)) = commit_live(&b, 3, "lab.rel_c", "lab.rel_c", ReleaseState::Uploading)
    else {
        unreachable!("refused");
    };
    assert_eq!(
        rollback(&c_flight, 3, true, "rel_rb", ReleaseState::Uploading),
        Err(RollbackRefusal::Commit(CommitLiveRefusal::InFlight))
    );
}

#[test]
fn a_stale_failure_with_an_old_mark_for_the_flights_own_script_leaves_the_flight() {
    // B served, then C served with B kept; a rollback to B is in flight with its own mark.
    let Ok((b, mark_b)) = served_live(&serving(Some("lab.rel_a"), 1, 4), 4, "lab.rel_b") else {
        unreachable!("refused");
    };
    let Ok((c, _)) = served_live(&b, 4, "lab.rel_c") else {
        unreachable!("refused");
    };
    let Ok((rolling, mark_r)) = rollback(&c, 4, true, "rel_rb", ReleaseState::Uploading) else {
        unreachable!("refused");
    };
    // B's old failure arrives, naming the same script with an old mark: stale, and the flight stays.
    assert_eq!(
        set_back(&rolling, &mark_b, "lab.rel_b"),
        Err(StaleCompletion)
    );
    assert!(rolling
        .in_flight
        .as_ref()
        .is_some_and(|f| f.is(&mark_r, "lab.rel_b")));
    assert!(!rolling
        .in_flight
        .as_ref()
        .is_some_and(|f| f.is(&mark_b, "lab.rel_b")));
    // Only the rollback's own failure sets it back.
    assert!(set_back(&rolling, &mark_r, "lab.rel_b").is_ok());
}

#[test]
fn the_default_host_is_never_opened_and_unpublish_always_deletes_the_flights_script() {
    let (second, mark) = second_in_flight();
    assert_eq!(open_host(&second, 0), None);
    assert!(confirm_served(&second, &mark, "lab.rel_2").is_ok());
    // Even if no host names the flight's script any more, an unpublish deletes it.
    let mut odd = second.clone();
    if let Some(h) = odd.hosts.first_mut() {
        h.script = Some("lab.rel_1".into());
    }
    let (_, delete) = unpublish(&odd);
    assert!(delete.contains(&"lab.rel_2".to_owned()));
    assert!(delete.contains(&"lab.rel_1".to_owned()));
}

#[test]
fn a_second_rollback_record_is_not_answered_with_the_firsts_flight() {
    let Ok((a, _)) = served_live(&serving(None, 1, 3), 3, "lab.rel_a") else {
        unreachable!("refused");
    };
    let Ok((b, _)) = served_live(&a, 3, "lab.rel_b") else {
        unreachable!("refused");
    };
    let first = rollback(&b, 3, true, "rel_rb_1", ReleaseState::Uploading);
    let Ok((rolling, _)) = first.clone() else {
        unreachable!("refused");
    };
    assert!(rolling
        .in_flight
        .as_ref()
        .is_some_and(|f| f.release_id == "rel_rb_1"));
    // The same rollback record, retried, replays; another rollback record is refused, not given the first's mark.
    assert_eq!(
        rollback(&rolling, 3, true, "rel_rb_1", ReleaseState::Live),
        first
    );
    assert_eq!(
        rollback(&rolling, 3, true, "rel_rb_2", ReleaseState::Uploading),
        Err(RollbackRefusal::Commit(CommitLiveRefusal::InFlight))
    );
    // A retry under another epoch is refused.
    assert_eq!(
        rollback(&rolling, 2, true, "rel_rb_1", ReleaseState::Live),
        Err(RollbackRefusal::Commit(CommitLiveRefusal::EpochMoved))
    );
}

#[test]
fn a_replay_needs_the_record_live_or_uploading() {
    let (second, _) = second_in_flight();
    for state in [
        ReleaseState::AwaitingApproval,
        ReleaseState::Queued,
        ReleaseState::Uncertain,
        ReleaseState::Served,
    ] {
        assert_eq!(
            commit_live(&second, 4, "lab.rel_2", "lab.rel_2", state),
            Err(CommitLiveRefusal::ReleaseNotUploading),
            "{state:?}"
        );
    }
    // A rollback retry is held to the same: its record's state is read, not ignored.
    let Ok((a, _)) = served_live(&serving(None, 1, 3), 3, "lab.rel_a") else {
        unreachable!("refused");
    };
    let Ok((b, _)) = served_live(&a, 3, "lab.rel_b") else {
        unreachable!("refused");
    };
    let Ok((rolling, _)) = rollback(&b, 3, true, "rel_rb_1", ReleaseState::Uploading) else {
        unreachable!("refused");
    };
    assert_eq!(
        rollback(&rolling, 3, true, "rel_rb_1", ReleaseState::Queued),
        Err(RollbackRefusal::Commit(
            CommitLiveRefusal::ReleaseNotUploading
        ))
    );
}

#[test]
fn an_ended_record_asking_for_the_flights_own_script_is_refused_as_ended() {
    let (second, _) = second_in_flight();
    for ended in [
        ReleaseState::Failed,
        ReleaseState::Declined,
        ReleaseState::Replaced,
        ReleaseState::Unpublished,
    ] {
        assert_eq!(
            commit_live(&second, 4, "lab.rel_2", "lab.rel_2", ended),
            Err(CommitLiveRefusal::ReleaseEnded),
            "{ended:?}"
        );
    }
    let Ok((a, _)) = served_live(&serving(None, 1, 3), 3, "lab.rel_a") else {
        unreachable!("refused");
    };
    let Ok((b, _)) = served_live(&a, 3, "lab.rel_b") else {
        unreachable!("refused");
    };
    let Ok((rolling, _)) = rollback(&b, 3, true, "rel_rb_1", ReleaseState::Uploading) else {
        unreachable!("refused");
    };
    assert_eq!(
        rollback(&rolling, 3, true, "rel_rb_1", ReleaseState::Failed),
        Err(RollbackRefusal::Commit(CommitLiveRefusal::ReleaseEnded))
    );
    assert_eq!(
        rollback(&rolling, 3, true, "rel_rb_2", ReleaseState::Failed),
        Err(RollbackRefusal::Commit(CommitLiveRefusal::ReleaseEnded))
    );
}

#[test]
fn an_upload_expires_exactly_when_the_reconcile_stops_keeping_its_script() {
    use podster_core::release::{upload_expired, UploadFailure, IN_FLIGHT_EXEMPTION_MS};
    let name = format!("abc.rel_{}", "a1".repeat(16));
    let since = 1_000_000;
    // One bound for both: at every moment the script is kept or the release is ended, never both and never neither.
    for now in [
        since,
        since + IN_FLIGHT_EXEMPTION_MS - 1,
        since + IN_FLIGHT_EXEMPTION_MS,
        since + IN_FLIGHT_EXEMPTION_MS + 1,
        i64::MAX,
    ] {
        let kept =
            reconcile_script(&name, RoomClaim::Uploading { since }, now) == ScriptReconcile::Keep;
        assert_eq!(upload_expired(since, now), !kept, "at {now}");
    }
    assert!(!upload_expired(since, since + IN_FLIGHT_EXEMPTION_MS - 1));
    assert!(upload_expired(since, since + IN_FLIGHT_EXEMPTION_MS));
    // A start time ahead of the clock hasn't expired, and nothing overflows.
    assert!(!upload_expired(i64::MAX, 0));
    assert!(upload_expired(i64::MIN, i64::MAX));
    let codes = [
        UploadFailure::Expired.code(),
        UploadFailure::ScriptDeleted.code(),
        UploadFailure::LabelRetired.code(),
    ];
    assert_eq!(
        codes,
        [
            "release_upload_expired",
            "release_script_deleted",
            "release_label_retired"
        ]
    );
}

#[test]
fn an_unanswered_switch_notice_waits_longer_each_time_and_is_told_from_the_twelfth_try_on() {
    let waits: Vec<u64> = (1..=9)
        .map(|tries| switch_notice_unanswered(tries).wait_ms)
        .collect();
    assert_eq!(
        waits,
        [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000]
    );
    // A count of 0 is the first try's, and nothing overflows however long it goes on.
    assert_eq!(switch_notice_unanswered(0), switch_notice_unanswered(1));
    for tries in [33, 64, 65, u32::MAX] {
        assert_eq!(
            switch_notice_unanswered(tries).wait_ms,
            SWITCH_NOTICE_MAX_WAIT_MS,
            "{tries}"
        );
    }
    // Operators are told at the twelfth unanswered try, and at every one after it: the notice is still sent.
    let told: Vec<u32> = (0..=40)
        .filter(|tries| switch_notice_unanswered(*tries).tell)
        .collect();
    assert_eq!(told, (12..=40).collect::<Vec<u32>>());
    assert_eq!(SWITCH_NOTICE_TOLD_AFTER, 12);
    assert!(switch_notice_unanswered(u32::MAX).tell);
    // The first eleven waits add up to about half an hour before operators hear.
    let before_told: u64 = (1..SWITCH_NOTICE_TOLD_AFTER)
        .map(|tries| switch_notice_unanswered(tries).wait_ms)
        .sum();
    assert_eq!(before_told, 1_815_000);
}

#[test]
fn a_repository_link_that_is_not_ready_unpublishes_as_adr_0010_is_written() {
    use podster_core::repositories::LinkStatus;
    // As built, by the architect's ruling of 2026-11-13: every status but ready. The owner's alternative is
    // `Suspended` only; answering it changes the `Degraded` row here and the one line in `link_status_unpublishes`.
    assert!(!link_status_unpublishes(LinkStatus::Ready));
    assert!(link_status_unpublishes(LinkStatus::Degraded));
    assert!(link_status_unpublishes(LinkStatus::Suspended));
}

#[test]
fn the_deployments_release_setting_has_three_readings_and_only_an_exact_false_unpublishes() {
    use DeploymentRelease::*;
    assert_eq!(deployment_release(Some("true")), On);
    assert_eq!(deployment_release(Some("false")), Off);
    // Unset, empty and every near miss are undecided: nothing released, nothing taken down.
    for setting in [
        None,
        Some(""),
        Some("True"),
        Some("TRUE"),
        Some("1"),
        Some("true "),
        Some(" true"),
        Some("False"),
        Some("0"),
        Some("no"),
        Some("off"),
    ] {
        assert_eq!(deployment_release(setting), Undecided, "{setting:?}");
    }
    assert_eq!(
        [On, Off, Undecided].map(|r| r.allows_release()),
        [true, false, false]
    );
    assert_eq!(
        [On, Off, Undecided].map(|r| r.unpublishes()),
        [false, true, false]
    );
}

// --- switching release on or off in a room ---------------------------------------------------------------------------

#[test]
fn setting_release_in_a_room_turns_it_on_or_off_only_from_the_version_read() {
    use ReleaseConfigChange::*;
    // Never set: version 0, off.
    assert_eq!(release_config_change(None, true, 0), Ok(TurnOn));
    assert_eq!(release_config_change(None, false, 0), Ok(Unchanged));
    // Set: from its own version only.
    assert_eq!(
        release_config_change(Some((true, 3)), false, 3),
        Ok(TurnOff)
    );
    assert_eq!(release_config_change(Some((false, 4)), true, 4), Ok(TurnOn));
    assert_eq!(
        release_config_change(Some((true, 3)), true, 3),
        Ok(Unchanged)
    );
    assert_eq!(
        release_config_change(Some((false, 4)), false, 4),
        Ok(Unchanged)
    );
}

#[test]
fn a_stale_version_is_refused_before_anything_else_an_unchanged_request_included() {
    let stale = Err(ReleaseConfigRefusal::VersionConflict);
    assert_eq!(release_config_change(None, true, 1), stale);
    assert_eq!(release_config_change(Some((true, 3)), false, 2), stale);
    assert_eq!(release_config_change(Some((true, 3)), true, 4), stale);
    assert_eq!(release_config_change(Some((false, 1)), false, 0), stale);
    assert_eq!(
        ReleaseConfigRefusal::VersionConflict.code(),
        "version_conflict"
    );
}
