//! Provider webhook deliveries and when to read the provider again (M5 step 5, ADR 0009, which is proposed). No I/O.
//!
//! A delivery is a nudge. It says something may have changed for a pull request or a commit, and nothing here lets it say
//! what. The room records that a nudge arrived, and what it knows about a change comes only from Podster's own read of the
//! provider, which steps 6 to 8 build. So this module holds three things: the shape of a nudge and what makes one
//! well-formed, how long a delivery ID is remembered, and when a change is due a read and whether the repository's hourly
//! allowance has room for one. The numbers are ADR 0009's proposals.

/// How long an accepted delivery ID is kept, so a replay inside that time is refused. Proposed: 7 days.
pub const DELIVERY_RETENTION_MS: i64 = 7 * 24 * 60 * 60 * 1000;
/// The most deliveries one room remembers. At the read cap a repository's useful nudges in the retention time come to
/// about this many. Past it a delivery still nudges and just isn't remembered, so stored rows stay bounded and no nudge is
/// lost: its replay then costs at most one more read, which the read cap bounds.
pub const MAX_DELIVERIES_HELD: i64 = 10_000;
/// Reads of the provider for one repository in any hour, from nudges and polling together. Proposed: 60. A merge job's own
/// reads aren't counted.
pub const MAX_READS_PER_HOUR: u32 = 60;
/// Polling backs off from a minute to an hour while reads find nothing new, as decision 117 does for A2A.
pub const POLL_MIN_MS: i64 = 60 * 1000;
pub const POLL_MAX_MS: i64 = 60 * 60 * 1000;
/// The longest delivery ID taken. GitHub's is a 36-character GUID.
pub const MAX_DELIVERY_ID_BYTES: usize = 64;
/// The most pull request numbers one nudge names. A check run can list several.
pub const MAX_PULL_REQUESTS: usize = 10;

/// The event kinds M5 uses. Anything else is refused at the gateway and again here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventKind {
    PullRequest,
    CheckRun,
    Status,
}

impl EventKind {
    pub fn name(self) -> &'static str {
        match self {
            EventKind::PullRequest => "pull_request",
            EventKind::CheckRun => "check_run",
            EventKind::Status => "status",
        }
    }

    pub fn from_name(name: &str) -> Option<EventKind> {
        [
            EventKind::PullRequest,
            EventKind::CheckRun,
            EventKind::Status,
        ]
        .into_iter()
        .find(|k| k.name() == name)
    }
}

/// A delivery ID is used as a key and may be logged, so it's held to a short run of letters, digits, `-` and `_`.
pub fn is_delivery_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_DELIVERY_ID_BYTES
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Whether this is a SHA-256 as written in hex: 64 lower-case digits.
pub fn is_body_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// A nudge: IDs and commit SHAs only. No title, body, branch name, URL or state, so nothing a provider's user typed gets
/// past the gateway, and nothing in it can be taken for what the provider's state is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Nudge {
    pub delivery_id: String,
    /// SHA-256 of the raw body the provider signed. The provider's signature covers the body and not the delivery ID, so
    /// one captured delivery could be sent again under any number of new IDs. The same body is the same delivery.
    pub body_sha256: String,
    pub event: EventKind,
    pub repository_id: i64,
    pub pull_requests: Vec<i64>,
    pub head_sha: Option<String>,
}

/// Whether a nudge is well-formed. It must name a repository, and a pull request or a commit, or there's nothing to look up.
pub fn is_well_formed(nudge: &Nudge) -> bool {
    is_delivery_id(&nudge.delivery_id)
        && is_body_digest(&nudge.body_sha256)
        && nudge.repository_id > 0
        && nudge.pull_requests.len() <= MAX_PULL_REQUESTS
        && nudge.pull_requests.iter().all(|n| *n > 0)
        && nudge
            .head_sha
            .as_deref()
            .is_none_or(crate::repositories::valid_commit_sha)
        && (!nudge.pull_requests.is_empty() || nudge.head_sha.is_some())
}

/// What the room does with a well-formed nudge, from its own rows. The room's link decides whose repository it is, never
/// the lookup that routed the delivery here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NudgeOutcome {
    /// The room has no linked repository, or a different one. Nothing is kept.
    NotThisRoom,
    /// This delivery ID, or this exact body, was taken before. Nothing changes.
    Replayed,
    /// It names no pull request or commit of a task here. Nothing is kept, so deliveries about other things can't fill the room.
    UnknownChange,
    /// A task's change is marked as due a read, and the delivery is remembered.
    Nudged,
    /// A task's change is marked as due a read, and the room already remembers as many deliveries as it keeps, so this one
    /// isn't remembered. A nudge is never refused for want of room.
    NudgedUnrecorded,
}

impl NudgeOutcome {
    pub fn code(self) -> &'static str {
        match self {
            NudgeOutcome::NotThisRoom => "not_this_room",
            NudgeOutcome::Replayed => "replayed",
            NudgeOutcome::UnknownChange => "unknown_change",
            NudgeOutcome::Nudged => "nudged",
            NudgeOutcome::NudgedUnrecorded => "nudged_unrecorded",
        }
    }
}

/// What the room's rows say about one delivery.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Arrival {
    /// The repository the room is linked to, if any.
    pub linked_repository: Option<i64>,
    /// The repository the delivery is about.
    pub observed_repository: i64,
    /// Whether the room remembers this delivery ID or this exact body.
    pub seen_before: bool,
    /// Whether it names a pull request or a commit of a task's change here.
    pub names_known_change: bool,
    /// How many deliveries the room remembers now.
    pub held: i64,
}

/// What to do with a delivery. Only `Nudged` writes a row for it, and only it and `NudgedUnrecorded` mark a change.
pub fn decide(arrival: &Arrival) -> NudgeOutcome {
    if arrival.linked_repository != Some(arrival.observed_repository) {
        NudgeOutcome::NotThisRoom
    } else if arrival.seen_before {
        NudgeOutcome::Replayed
    } else if !arrival.names_known_change {
        NudgeOutcome::UnknownChange
    } else if arrival.held >= MAX_DELIVERIES_HELD {
        NudgeOutcome::NudgedUnrecorded
    } else {
        NudgeOutcome::Nudged
    }
}

/// What the room holds about one task's change, as far as reading the provider goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChangeWatch {
    /// When the last accepted nudge about it arrived.
    pub nudged_at: Option<i64>,
    /// When Podster last read it from the provider.
    pub read_at: Option<i64>,
    /// Reads in a row that found nothing new. Sets the polling backoff.
    pub unchanged_reads: u32,
    /// Whether it's still to be watched: submitted or approved, and not merged, closed or on an ended task.
    pub watched: bool,
}

/// Why a change is due a read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stale {
    /// A nudge arrived after the last read, or it has never been read.
    Nudged,
    /// No nudge, and the polling wait since the last read is over. This is what repairs a lost delivery.
    PollDue,
}

/// How long polling waits after a read: a minute, doubling with each read that found nothing new, up to an hour.
pub fn poll_wait_ms(unchanged_reads: u32) -> i64 {
    POLL_MIN_MS
        .checked_shl(unchanged_reads.min(16))
        .map_or(POLL_MAX_MS, |wait| wait.clamp(POLL_MIN_MS, POLL_MAX_MS))
}

/// Whether what the room holds about a change is stale at `now`, and why. A change no longer watched is never stale: a
/// nudge about it costs nothing.
pub fn stale(watch: &ChangeWatch, now: i64) -> Option<Stale> {
    if !watch.watched {
        return None;
    }
    let Some(read_at) = watch.read_at else {
        return Some(Stale::Nudged);
    };
    if watch.nudged_at.is_some_and(|nudged| nudged > read_at) {
        return Some(Stale::Nudged);
    }
    (now.saturating_sub(read_at) >= poll_wait_ms(watch.unchanged_reads)).then_some(Stale::PollDue)
}

/// Whether a repository's hourly allowance has room for one more read, given how many it has made in the last hour. Over
/// the cap the read is dropped, not queued, and the next poll catches up.
pub fn read_allowed(reads_in_last_hour: u32) -> bool {
    reads_in_last_hour < MAX_READS_PER_HOUR
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nudge() -> Nudge {
        Nudge {
            delivery_id: "72d3162e-cc78-11e3-81ab-4c9367dc0958".to_string(),
            body_sha256: "5e".repeat(32),
            event: EventKind::PullRequest,
            repository_id: 987_654_321,
            pull_requests: vec![7],
            head_sha: Some("a1".repeat(20)),
        }
    }

    #[test]
    fn event_kinds_round_trip_and_nothing_else_is_one() {
        for kind in [
            EventKind::PullRequest,
            EventKind::CheckRun,
            EventKind::Status,
        ] {
            assert_eq!(EventKind::from_name(kind.name()), Some(kind));
        }
        for other in [
            "push",
            "ping",
            "installation",
            "check_suite",
            "",
            "Pull_Request",
        ] {
            assert_eq!(EventKind::from_name(other), None, "{other}");
        }
    }

    #[test]
    fn a_delivery_id_is_short_and_plain() {
        assert!(is_delivery_id("72d3162e-cc78-11e3-81ab-4c9367dc0958"));
        assert!(is_delivery_id(&"a".repeat(MAX_DELIVERY_ID_BYTES)));
        for bad in [
            "",
            "a b",
            "a/b",
            "a\nb",
            "d\u{e9}",
            &"a".repeat(MAX_DELIVERY_ID_BYTES + 1),
        ] {
            assert!(!is_delivery_id(bad), "{bad}");
        }
    }

    #[test]
    fn a_nudge_needs_a_repository_and_something_to_look_up() {
        assert!(is_well_formed(&nudge()));
        assert!(is_well_formed(&Nudge {
            pull_requests: vec![],
            ..nudge()
        }));
        assert!(is_well_formed(&Nudge {
            head_sha: None,
            ..nudge()
        }));
        assert!(is_well_formed(&Nudge {
            head_sha: Some("b2".repeat(32)),
            ..nudge()
        }));
        assert!(!is_well_formed(&Nudge {
            pull_requests: vec![],
            head_sha: None,
            ..nudge()
        }));
        assert!(!is_well_formed(&Nudge {
            repository_id: 0,
            ..nudge()
        }));
        assert!(!is_well_formed(&Nudge {
            repository_id: -4,
            ..nudge()
        }));
        assert!(!is_well_formed(&Nudge {
            pull_requests: vec![7, 0],
            ..nudge()
        }));
        assert!(!is_well_formed(&Nudge {
            pull_requests: vec![1; MAX_PULL_REQUESTS + 1],
            ..nudge()
        }));
        assert!(!is_well_formed(&Nudge {
            head_sha: Some("main".to_string()),
            ..nudge()
        }));
        assert!(!is_well_formed(&Nudge {
            head_sha: Some("a1".repeat(19)),
            ..nudge()
        }));
        assert!(!is_well_formed(&Nudge {
            delivery_id: "a b".to_string(),
            ..nudge()
        }));
    }

    #[test]
    fn the_rooms_own_link_decides_first_and_a_nudge_is_never_lost_for_want_of_room() {
        let known = Arrival {
            linked_repository: Some(5),
            observed_repository: 5,
            seen_before: false,
            names_known_change: true,
            held: 0,
        };
        assert_eq!(decide(&known), NudgeOutcome::Nudged);
        // No link, or another repository: nothing else is even looked at.
        for linked in [None, Some(6)] {
            for seen_before in [false, true] {
                let other = Arrival {
                    linked_repository: linked,
                    seen_before,
                    held: MAX_DELIVERIES_HELD,
                    ..known
                };
                assert_eq!(decide(&other), NudgeOutcome::NotThisRoom);
            }
        }
        // A replay is a replay, full or not, known change or not.
        assert_eq!(
            decide(&Arrival {
                seen_before: true,
                ..known
            }),
            NudgeOutcome::Replayed
        );
        assert_eq!(
            decide(&Arrival {
                seen_before: true,
                names_known_change: false,
                held: MAX_DELIVERIES_HELD,
                ..known
            }),
            NudgeOutcome::Replayed
        );
        // About nothing here: dropped, full or not.
        assert_eq!(
            decide(&Arrival {
                names_known_change: false,
                ..known
            }),
            NudgeOutcome::UnknownChange
        );
        assert_eq!(
            decide(&Arrival {
                names_known_change: false,
                held: MAX_DELIVERIES_HELD,
                ..known
            }),
            NudgeOutcome::UnknownChange
        );
        // Full: it still nudges, and isn't remembered.
        assert_eq!(
            decide(&Arrival {
                held: MAX_DELIVERIES_HELD - 1,
                ..known
            }),
            NudgeOutcome::Nudged
        );
        assert_eq!(
            decide(&Arrival {
                held: MAX_DELIVERIES_HELD,
                ..known
            }),
            NudgeOutcome::NudgedUnrecorded
        );
        assert_eq!(
            decide(&Arrival {
                held: MAX_DELIVERIES_HELD + 9,
                ..known
            }),
            NudgeOutcome::NudgedUnrecorded
        );
    }

    #[test]
    fn a_body_digest_is_64_lower_case_hex_digits() {
        assert!(is_body_digest(&"0f".repeat(32)));
        for bad in [
            "",
            &"0F".repeat(32),
            &"0f".repeat(31),
            &"0g".repeat(32),
            &"0f".repeat(33),
        ] {
            assert!(!is_body_digest(bad), "{bad}");
        }
        assert!(!is_well_formed(&Nudge {
            body_sha256: "x".to_string(),
            ..nudge()
        }));
    }

    #[test]
    fn polling_backs_off_from_a_minute_to_an_hour() {
        assert_eq!(poll_wait_ms(0), 60_000);
        assert_eq!(poll_wait_ms(1), 120_000);
        assert_eq!(poll_wait_ms(5), 1_920_000);
        assert_eq!(poll_wait_ms(6), POLL_MAX_MS);
        assert_eq!(poll_wait_ms(40), POLL_MAX_MS);
        assert_eq!(poll_wait_ms(u32::MAX), POLL_MAX_MS);
        let mut last = 0;
        for reads in 0..70 {
            let wait = poll_wait_ms(reads);
            assert!(wait >= last && (POLL_MIN_MS..=POLL_MAX_MS).contains(&wait));
            last = wait;
        }
    }

    #[test]
    fn a_change_is_stale_after_a_nudge_or_when_its_poll_is_due() {
        let watch = ChangeWatch {
            nudged_at: None,
            read_at: Some(1_000_000),
            unchanged_reads: 0,
            watched: true,
        };
        // Never read: due at once, nudge or not.
        assert_eq!(
            stale(
                &ChangeWatch {
                    read_at: None,
                    ..watch
                },
                0
            ),
            Some(Stale::Nudged)
        );
        // Read, and nothing since: not stale until the wait is over.
        assert_eq!(stale(&watch, 1_000_000), None);
        assert_eq!(stale(&watch, 1_059_999), None);
        assert_eq!(stale(&watch, 1_060_000), Some(Stale::PollDue));
        // A longer wait after reads that found nothing.
        let quiet = ChangeWatch {
            unchanged_reads: 3,
            ..watch
        };
        assert_eq!(stale(&quiet, 1_060_000), None);
        assert_eq!(stale(&quiet, 1_480_000), Some(Stale::PollDue));
        // A nudge after the read makes it stale at once. One from before the read, or at the same instant, doesn't.
        assert_eq!(
            stale(
                &ChangeWatch {
                    nudged_at: Some(1_000_001),
                    ..watch
                },
                1_000_001
            ),
            Some(Stale::Nudged)
        );
        assert_eq!(
            stale(
                &ChangeWatch {
                    nudged_at: Some(1_000_000),
                    ..watch
                },
                1_000_001
            ),
            None
        );
        assert_eq!(
            stale(
                &ChangeWatch {
                    nudged_at: Some(999_999),
                    ..watch
                },
                1_000_001
            ),
            None
        );
        // A clock that went backwards doesn't make it due.
        assert_eq!(stale(&watch, 0), None);
        // Merged, closed or ended: never, whatever arrives.
        let done = ChangeWatch {
            nudged_at: Some(2_000_000),
            read_at: None,
            unchanged_reads: 0,
            watched: false,
        };
        assert_eq!(stale(&done, 9_000_000), None);
    }

    #[test]
    fn a_repository_reads_at_most_its_hourly_allowance() {
        assert!(read_allowed(0));
        assert!(read_allowed(MAX_READS_PER_HOUR - 1));
        assert!(!read_allowed(MAX_READS_PER_HOUR));
        assert!(!read_allowed(u32::MAX));
    }
}
