//! A Runner pairing session's decisions (M7 step 5(a); decision 222; RUNNER.md "Proposed one-agent pairing proof of
//! concept"; M7 security review S-07). Pure: no I/O, no clock, no randomness.
//!
//! A signed-in person starts a session for one new agent in one organization. The session holds a verifier of a one-time
//! code, never the code. Runner later presents the code with a public key whose possession the gateway has checked: that
//! is a **redemption**, and it binds the key's thumbprint to the session. The person who started it then confirms that
//! thumbprint: that is the **activation**, the one effective outcome, after which the session can't change again.
//!
//! Every limit fails closed: a session whose attempts are spent is locked for good, an expired session takes nothing, and
//! a refusal never changes the key a session holds. Who may do each step is `podster-policy`'s, decided before this runs.

/// How long a session lasts from its start, redemption and confirmation included: ten minutes, well inside the Agent
/// Auth plugin's own hour for its enrollment token, so the shorter of the two always decides.
pub const SESSION_TTL_MS: i64 = 10 * 60 * 1000;
/// The plugin's enrollment token lives an hour, fixed in its defaults. A session must end first.
pub const PLUGIN_TOKEN_TTL_MS: i64 = 60 * 60 * 1000;
const _: () = assert!(SESSION_TTL_MS < PLUGIN_TOKEN_TTL_MS);
/// Wrong codes a session takes before it locks for good. The code is a one-time token of at least
/// [`CODE_MIN_BYTES`] characters, so these attempts are for typing mistakes, not a search.
pub const MAX_ATTEMPTS: i64 = 5;
/// Sessions one person may start in [`STARTS_WINDOW_MS`], across all their organizations.
pub const MAX_STARTS: usize = 5;
pub const STARTS_WINDOW_MS: i64 = 60 * 60 * 1000;
/// A code's bounds, in bytes of base64url text. The plugin's enrollment token is 43 (32 random bytes); the floor keeps a
/// short, guessable code from ever being stored, since the verifier is a plain hash.
pub const CODE_MIN_BYTES: usize = 32;
pub const CODE_MAX_BYTES: usize = 128;
/// A key's RFC 7638 thumbprint: SHA-256, base64url without padding.
pub const THUMBPRINT_BYTES: usize = 43;

/// Where a session is. Expiry isn't stored: it's read from the time, so nothing has to run for a session to expire.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    /// Started, waiting for Runner's code.
    Pending,
    /// Runner's code and key were taken; waiting for the person's confirmation.
    Redeemed,
    /// Confirmed. The agent exists and the session is closed.
    Activated,
    /// The person ended it.
    Canceled,
    /// Its attempts ran out.
    Locked,
}

impl Status {
    // codes: reasons
    pub fn code(self) -> &'static str {
        match self {
            Status::Pending => "pending",
            Status::Redeemed => "redeemed",
            Status::Activated => "activated",
            Status::Canceled => "canceled",
            Status::Locked => "locked",
        }
    }

    pub fn parse(value: &str) -> Option<Status> {
        [
            Status::Pending,
            Status::Redeemed,
            Status::Activated,
            Status::Canceled,
            Status::Locked,
        ]
        .into_iter()
        .find(|status| status.code() == value)
    }
}

/// What a session decides on. The code's verifier, its organization and its starter are the caller's to keep.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Session {
    pub status: Status,
    pub attempts: i64,
    pub expires_at: i64,
    pub key_thumbprint: Option<String>,
}

/// Why a step was refused. A reason for the session's audit, never shown to Runner: every refusal of a redemption looks
/// the same from outside.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// Activated or canceled: nothing changes it now.
    Closed,
    /// Past its expiry.
    Expired,
    /// The code didn't match. Counted.
    WrongCode,
    /// Its attempts ran out, now or before.
    Locked,
    /// A key other than the one the session holds.
    KeyMismatch,
    /// Confirmed before Runner redeemed it.
    NotRedeemed,
    /// Confirmed before Runner registered its agent on the session's host (M7 step 5(c)).
    NotRegistered,
    /// The plugin's host or agent isn't the one the binding rule allows (M7 step 5(c)).
    BindingMismatch,
}

impl Refusal {
    // codes: reasons
    pub fn code(self) -> &'static str {
        match self {
            Refusal::Closed => "closed",
            Refusal::Expired => "expired",
            Refusal::WrongCode => "wrong_code",
            Refusal::Locked => "locked",
            Refusal::KeyMismatch => "key_mismatch",
            Refusal::NotRedeemed => "not_redeemed",
            Refusal::NotRegistered => "not_registered",
            Refusal::BindingMismatch => "binding_mismatch",
        }
    }
}

/// What a step did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Redeemed,
    /// The same code and key again, after a lost answer: the same outcome, with nothing changed.
    AlreadyRedeemed,
    Activated,
    /// The same confirmation again: the same outcome, with nothing changed.
    AlreadyActivated,
    Canceled,
    AlreadyCanceled,
    Refused(Refusal),
}

/// A step's decision: the session to keep, which may differ from the one it started from even when refused (a wrong
/// code is counted), and what happened.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Decision {
    pub next: Session,
    pub outcome: Outcome,
}

fn unchanged(session: &Session, outcome: Outcome) -> Decision {
    Decision {
        next: session.clone(),
        outcome,
    }
}

/// A new session's expiry, from its start.
pub fn expires_at(started_at: i64) -> i64 {
    started_at.saturating_add(SESSION_TTL_MS)
}

/// A new session, as it starts.
pub fn start(started_at: i64) -> Session {
    Session {
        status: Status::Pending,
        attempts: 0,
        expires_at: expires_at(started_at),
        key_thumbprint: None,
    }
}

pub fn is_expired(session: &Session, now: i64) -> bool {
    now >= session.expires_at
}

/// The status to show: an open session past its expiry reads as `expired`.
// codes: reasons
pub fn shown_status(session: &Session, now: i64) -> &'static str {
    match session.status {
        Status::Pending | Status::Redeemed if is_expired(session, now) => "expired",
        status => status.code(),
    }
}

/// Whether a person who started these sessions, at these times, may start another now. Starts outside the window don't
/// count. At the limit, the answer is no.
pub fn may_start(starts: &[i64], now: i64) -> bool {
    let since = now.saturating_sub(STARTS_WINDOW_MS);
    starts.iter().filter(|at| **at > since).count() < MAX_STARTS
}

fn is_base64url(value: &str) -> bool {
    value
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Whether a code can be a session's: base64url text within [`CODE_MIN_BYTES`] and [`CODE_MAX_BYTES`].
pub fn valid_code(code: &str) -> bool {
    (CODE_MIN_BYTES..=CODE_MAX_BYTES).contains(&code.len()) && is_base64url(code)
}

/// Whether a value is a key thumbprint's shape: exactly [`THUMBPRINT_BYTES`] of base64url.
pub fn valid_thumbprint(value: &str) -> bool {
    value.len() == THUMBPRINT_BYTES && is_base64url(value)
}

/// Compares two verifiers in time that depends only on their lengths.
pub fn verifiers_match(stored: &[u8], offered: &[u8]) -> bool {
    if stored.len() != offered.len() {
        return false;
    }
    stored
        .iter()
        .zip(offered)
        .fold(0u8, |diff, (a, b)| diff | (a ^ b))
        == 0
}

/// Runner presents a code, which the caller has compared with the session's verifier (`code_matches`), and the
/// thumbprint of a key whose possession the gateway has checked.
pub fn redeem(session: &Session, now: i64, code_matches: bool, thumbprint: &str) -> Decision {
    match session.status {
        Status::Activated | Status::Canceled => {
            unchanged(session, Outcome::Refused(Refusal::Closed))
        }
        Status::Locked => unchanged(session, Outcome::Refused(Refusal::Locked)),
        _ if is_expired(session, now) => unchanged(session, Outcome::Refused(Refusal::Expired)),
        // Taken already: only the same code with the same key gets the same answer again. A wrong code here counts
        // nothing, since the code is spent.
        Status::Redeemed => {
            if code_matches && session.key_thumbprint.as_deref() == Some(thumbprint) {
                unchanged(session, Outcome::AlreadyRedeemed)
            } else {
                unchanged(session, Outcome::Refused(Refusal::Closed))
            }
        }
        Status::Pending if session.attempts >= MAX_ATTEMPTS => Decision {
            next: Session {
                status: Status::Locked,
                ..session.clone()
            },
            outcome: Outcome::Refused(Refusal::Locked),
        },
        Status::Pending if !code_matches => {
            let attempts = session.attempts.saturating_add(1);
            let locked = attempts >= MAX_ATTEMPTS;
            Decision {
                next: Session {
                    status: if locked {
                        Status::Locked
                    } else {
                        Status::Pending
                    },
                    attempts,
                    ..session.clone()
                },
                outcome: Outcome::Refused(if locked {
                    Refusal::Locked
                } else {
                    Refusal::WrongCode
                }),
            }
        }
        Status::Pending => Decision {
            next: Session {
                status: Status::Redeemed,
                key_thumbprint: Some(thumbprint.to_string()),
                ..session.clone()
            },
            outcome: Outcome::Redeemed,
        },
    }
}

/// The person confirms the thumbprint they were shown. Who may confirm, and whether their authority still holds, is
/// decided before this runs.
pub fn activate(session: &Session, now: i64, thumbprint: &str) -> Decision {
    let same_key = session.key_thumbprint.as_deref() == Some(thumbprint);
    match session.status {
        Status::Activated if same_key => unchanged(session, Outcome::AlreadyActivated),
        Status::Activated => unchanged(session, Outcome::Refused(Refusal::KeyMismatch)),
        Status::Canceled => unchanged(session, Outcome::Refused(Refusal::Closed)),
        Status::Locked => unchanged(session, Outcome::Refused(Refusal::Locked)),
        _ if is_expired(session, now) => unchanged(session, Outcome::Refused(Refusal::Expired)),
        Status::Pending => unchanged(session, Outcome::Refused(Refusal::NotRedeemed)),
        Status::Redeemed if !same_key => unchanged(session, Outcome::Refused(Refusal::KeyMismatch)),
        Status::Redeemed => Decision {
            next: Session {
                status: Status::Activated,
                ..session.clone()
            },
            outcome: Outcome::Activated,
        },
    }
}

/// The person ends a session that isn't activated. Expired and locked sessions can be canceled too, which only records
/// it; an activated one can't.
pub fn cancel(session: &Session) -> Decision {
    match session.status {
        Status::Activated => unchanged(session, Outcome::Refused(Refusal::Closed)),
        Status::Canceled => unchanged(session, Outcome::AlreadyCanceled),
        Status::Pending | Status::Redeemed | Status::Locked => Decision {
            next: Session {
                status: Status::Canceled,
                ..session.clone()
            },
            outcome: Outcome::Canceled,
        },
    }
}

/// Plugin agents a host may hold for a link to be decided. More than this is never one, so the reader need read no more.
pub const MAX_HOST_AGENTS: usize = 5;

/// A plugin agent on the session's host, as the gateway read it: its ID and whether the plugin holds it active.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PluginAgent {
    pub id: String,
    pub active: bool,
}

/// What the gateway read of the Agent Auth plugin's state for a session's host, at confirmation (M7 step 5(c)). Facts,
/// not authority: whether they let the session's agent be linked is decided here.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PluginFacts {
    /// The host that was read, which must be the session's own.
    pub host_id: String,
    /// The person who owns that host in the plugin, as a Podster person ID, or empty for none.
    pub host_owner: String,
    /// Whether the plugin holds that host active.
    pub host_active: bool,
    /// The RFC 7638 thumbprint of the key that host holds, or empty for none.
    pub host_thumbprint: String,
    /// How many plugin hosts hold that key, in any state.
    pub hosts_holding_key: i64,
    /// The host's plugin agents that aren't revoked, at most [`MAX_HOST_AGENTS`] + 1 of them.
    pub agents: Vec<PluginAgent>,
}

/// The one plugin agent a confirmed session links to its Podster agent (M7 step 5(c), the binding rule ruled on #449):
/// the only agent, active, on the session's own plugin host, which its starter owns, which holds the session's
/// thumbprint, and which is the only host holding it. `plugin_host_id`, `starter` and `thumbprint` are the session's.
/// No agent there yet is [`Refusal::NotRegistered`], which Runner can still fix; anything else is
/// [`Refusal::BindingMismatch`]. A session that is canceled, expired or locked never gets here: [`activate`] refuses it.
pub fn link_target<'a>(
    facts: &'a PluginFacts,
    plugin_host_id: &str,
    starter: &str,
    thumbprint: &str,
) -> Result<&'a str, Refusal> {
    let host_holds_key = facts.host_id == plugin_host_id
        && facts.host_active
        && !starter.is_empty()
        && facts.host_owner == starter
        && valid_thumbprint(thumbprint)
        && facts.host_thumbprint == thumbprint
        && facts.hosts_holding_key == 1;
    if !host_holds_key {
        return Err(Refusal::BindingMismatch);
    }
    match facts.agents.as_slice() {
        [] => Err(Refusal::NotRegistered),
        [only] if only.active && !only.id.is_empty() => Ok(only.id.as_str()),
        _ => Err(Refusal::BindingMismatch),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: i64 = 1_000_000;
    const KEY: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const OTHER_KEY: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    fn redeemed() -> Session {
        redeem(&start(T0), T0 + 1, true, KEY).next
    }

    #[test]
    fn a_session_lasts_ten_minutes_inside_the_plugins_hour() {
        let session = start(T0);
        assert_eq!(session.expires_at, T0 + 600_000);
        assert_eq!(session.status, Status::Pending);
        assert_eq!(session.attempts, 0);
        assert_eq!(session.key_thumbprint, None);
        assert!(!is_expired(&session, T0 + 599_999));
        assert!(is_expired(&session, T0 + 600_000));
    }

    #[test]
    fn the_right_code_binds_the_key_once() {
        let decision = redeem(&start(T0), T0 + 1, true, KEY);
        assert_eq!(decision.outcome, Outcome::Redeemed);
        assert_eq!(decision.next.status, Status::Redeemed);
        assert_eq!(decision.next.key_thumbprint.as_deref(), Some(KEY));
    }

    #[test]
    fn a_retry_with_the_same_code_and_key_answers_the_same_and_changes_nothing() {
        let session = redeemed();
        let again = redeem(&session, T0 + 2, true, KEY);
        assert_eq!(again.outcome, Outcome::AlreadyRedeemed);
        assert_eq!(again.next, session);
    }

    #[test]
    fn a_spent_code_with_another_key_is_refused_and_keeps_the_first_key() {
        let session = redeemed();
        let other = redeem(&session, T0 + 2, true, OTHER_KEY);
        assert_eq!(other.outcome, Outcome::Refused(Refusal::Closed));
        assert_eq!(other.next, session);
        let wrong = redeem(&session, T0 + 2, false, KEY);
        assert_eq!(wrong.outcome, Outcome::Refused(Refusal::Closed));
        assert_eq!(wrong.next, session);
    }

    #[test]
    fn wrong_codes_are_counted_and_the_fifth_locks_it_for_good() {
        let mut session = start(T0);
        for n in 1..MAX_ATTEMPTS {
            let decision = redeem(&session, T0 + n, false, KEY);
            assert_eq!(decision.outcome, Outcome::Refused(Refusal::WrongCode));
            assert_eq!(decision.next.attempts, n);
            assert_eq!(decision.next.status, Status::Pending);
            session = decision.next;
        }
        let last = redeem(&session, T0 + 10, false, KEY);
        assert_eq!(last.outcome, Outcome::Refused(Refusal::Locked));
        assert_eq!(last.next.status, Status::Locked);
        // Locked, even the right code is refused, and nothing is bound.
        let after = redeem(&last.next, T0 + 11, true, KEY);
        assert_eq!(after.outcome, Outcome::Refused(Refusal::Locked));
        assert_eq!(after.next.key_thumbprint, None);
        assert_eq!(
            activate(&last.next, T0 + 12, KEY).outcome,
            Outcome::Refused(Refusal::Locked)
        );
    }

    #[test]
    fn a_pending_session_already_at_its_limit_locks_rather_than_redeeming() {
        let session = Session {
            attempts: MAX_ATTEMPTS,
            ..start(T0)
        };
        let decision = redeem(&session, T0 + 1, true, KEY);
        assert_eq!(decision.outcome, Outcome::Refused(Refusal::Locked));
        assert_eq!(decision.next.status, Status::Locked);
        assert_eq!(decision.next.key_thumbprint, None);
    }

    #[test]
    fn an_expired_session_takes_nothing_and_counts_nothing() {
        let session = start(T0);
        let late = redeem(&session, session.expires_at, true, KEY);
        assert_eq!(late.outcome, Outcome::Refused(Refusal::Expired));
        assert_eq!(late.next, session);
        let late_wrong = redeem(&session, session.expires_at, false, KEY);
        assert_eq!(late_wrong.next.attempts, 0);
        // A redeemed session past its expiry can't be confirmed, or retried.
        let taken = redeemed();
        assert_eq!(
            activate(&taken, taken.expires_at, KEY).outcome,
            Outcome::Refused(Refusal::Expired)
        );
        assert_eq!(
            redeem(&taken, taken.expires_at, true, KEY).outcome,
            Outcome::Refused(Refusal::Expired)
        );
    }

    #[test]
    fn activation_needs_a_redemption_and_the_same_key() {
        assert_eq!(
            activate(&start(T0), T0 + 1, KEY).outcome,
            Outcome::Refused(Refusal::NotRedeemed)
        );
        let session = redeemed();
        let wrong = activate(&session, T0 + 2, OTHER_KEY);
        assert_eq!(wrong.outcome, Outcome::Refused(Refusal::KeyMismatch));
        assert_eq!(wrong.next, session);
        let done = activate(&session, T0 + 3, KEY);
        assert_eq!(done.outcome, Outcome::Activated);
        assert_eq!(done.next.status, Status::Activated);
        assert_eq!(done.next.key_thumbprint.as_deref(), Some(KEY));
    }

    #[test]
    fn activation_has_one_outcome() {
        let active = activate(&redeemed(), T0 + 3, KEY).next;
        let again = activate(&active, T0 + 4, KEY);
        assert_eq!(again.outcome, Outcome::AlreadyActivated);
        assert_eq!(again.next, active);
        // Another key after activation never replaces the first.
        let other = activate(&active, T0 + 4, OTHER_KEY);
        assert_eq!(other.outcome, Outcome::Refused(Refusal::KeyMismatch));
        assert_eq!(other.next, active);
        // Even after its expiry, the activated session answers the same and can't be redeemed or canceled.
        assert_eq!(
            activate(&active, active.expires_at + 1, KEY).outcome,
            Outcome::AlreadyActivated
        );
        assert_eq!(
            redeem(&active, T0 + 5, true, KEY).outcome,
            Outcome::Refused(Refusal::Closed)
        );
        assert_eq!(cancel(&active).outcome, Outcome::Refused(Refusal::Closed));
    }

    #[test]
    fn a_canceled_session_takes_nothing() {
        let canceled = cancel(&redeemed());
        assert_eq!(canceled.outcome, Outcome::Canceled);
        assert_eq!(canceled.next.status, Status::Canceled);
        assert_eq!(cancel(&canceled.next).outcome, Outcome::AlreadyCanceled);
        assert_eq!(
            redeem(&canceled.next, T0 + 2, true, KEY).outcome,
            Outcome::Refused(Refusal::Closed)
        );
        assert_eq!(
            activate(&canceled.next, T0 + 2, KEY).outcome,
            Outcome::Refused(Refusal::Closed)
        );
        assert_eq!(cancel(&start(T0)).outcome, Outcome::Canceled);
    }

    #[test]
    fn the_shown_status_reads_expiry_from_the_time() {
        let session = start(T0);
        assert_eq!(shown_status(&session, T0), "pending");
        assert_eq!(shown_status(&session, session.expires_at), "expired");
        assert_eq!(shown_status(&redeemed(), session.expires_at), "expired");
        let active = activate(&redeemed(), T0 + 3, KEY).next;
        assert_eq!(shown_status(&active, active.expires_at + 1), "activated");
        assert_eq!(
            shown_status(&cancel(&session).next, session.expires_at + 1),
            "canceled"
        );
    }

    #[test]
    fn statuses_round_trip() {
        for status in [
            Status::Pending,
            Status::Redeemed,
            Status::Activated,
            Status::Canceled,
            Status::Locked,
        ] {
            assert_eq!(Status::parse(status.code()), Some(status));
        }
        assert_eq!(Status::parse("expired"), None);
        assert_eq!(Status::parse(""), None);
    }

    #[test]
    fn a_person_starts_at_most_five_an_hour() {
        let now = T0 + STARTS_WINDOW_MS;
        assert!(may_start(&[], now));
        let four = [now - 1, now - 2, now - 3, now - 4];
        assert!(may_start(&four, now));
        let five = [now - 1, now - 2, now - 3, now - 4, now - 5];
        assert!(!may_start(&five, now));
        // Starts an hour old or more don't count.
        let old = [T0, T0 - 1, now - 1, now - 2, now - 3];
        assert!(may_start(&old, now));
    }

    #[test]
    fn codes_and_thumbprints_have_fixed_shapes() {
        assert!(valid_code(&"A".repeat(43)));
        assert!(valid_code(&"a-_9".repeat(8)));
        assert!(!valid_code(&"A".repeat(31)));
        assert!(!valid_code(&"A".repeat(129)));
        assert!(!valid_code(&format!("{}=", "A".repeat(42))));
        assert!(!valid_code(&format!("{} ", "A".repeat(42))));
        assert!(!valid_code(&format!("{}é", "A".repeat(41))));
        assert!(valid_thumbprint(KEY));
        assert!(!valid_thumbprint(&"a".repeat(42)));
        assert!(!valid_thumbprint(&"a".repeat(44)));
        assert!(!valid_thumbprint(&format!("{}+", "a".repeat(42))));
    }

    #[test]
    fn verifiers_compare_whole() {
        assert!(verifiers_match(b"abc", b"abc"));
        assert!(!verifiers_match(b"abc", b"abd"));
        assert!(!verifiers_match(b"abc", b"ab"));
        assert!(!verifiers_match(b"", b"a"));
    }

    fn facts() -> PluginFacts {
        PluginFacts {
            host_id: "host_1".into(),
            host_owner: "per_a".into(),
            host_active: true,
            host_thumbprint: KEY.into(),
            hosts_holding_key: 1,
            agents: vec![PluginAgent {
                id: "plug_1".into(),
                active: true,
            }],
        }
    }

    #[test]
    fn links_only_the_one_active_agent_on_the_sessions_own_host_holding_its_key() {
        assert_eq!(link_target(&facts(), "host_1", "per_a", KEY), Ok("plug_1"));
    }

    #[test]
    fn waits_for_runner_to_register_its_agent() {
        let none = PluginFacts {
            agents: vec![],
            ..facts()
        };
        assert_eq!(
            link_target(&none, "host_1", "per_a", KEY),
            Err(Refusal::NotRegistered)
        );
    }

    #[test]
    fn refuses_any_host_agent_owner_or_key_the_rule_does_not_allow() {
        let mismatch = Err(Refusal::BindingMismatch);
        // Another host than the session's.
        assert_eq!(link_target(&facts(), "host_2", "per_a", KEY), mismatch);
        // A host the starter doesn't own, or no one owns.
        assert_eq!(link_target(&facts(), "host_1", "per_b", KEY), mismatch);
        let unowned = PluginFacts {
            host_owner: String::new(),
            ..facts()
        };
        assert_eq!(link_target(&unowned, "host_1", "", KEY), mismatch);
        // A key other than the session's, or one the host doesn't hold.
        assert_eq!(
            link_target(&facts(), "host_1", "per_a", OTHER_KEY),
            mismatch
        );
        let keyless = PluginFacts {
            host_thumbprint: String::new(),
            ..facts()
        };
        assert_eq!(link_target(&keyless, "host_1", "per_a", ""), mismatch);
        // The key on two hosts, or on none the reader found.
        for holders in [0, 2, 3] {
            let shared = PluginFacts {
                hosts_holding_key: holders,
                ..facts()
            };
            assert_eq!(link_target(&shared, "host_1", "per_a", KEY), mismatch);
        }
        // A host the plugin no longer holds active.
        let revoked = PluginFacts {
            host_active: false,
            ..facts()
        };
        assert_eq!(link_target(&revoked, "host_1", "per_a", KEY), mismatch);
        // Two agents on the host, or one the plugin doesn't hold active: never a guess at which.
        let two = PluginFacts {
            agents: vec![
                PluginAgent {
                    id: "plug_1".into(),
                    active: true,
                },
                PluginAgent {
                    id: "plug_2".into(),
                    active: true,
                },
            ],
            ..facts()
        };
        assert_eq!(link_target(&two, "host_1", "per_a", KEY), mismatch);
        let pending = PluginFacts {
            agents: vec![PluginAgent {
                id: "plug_1".into(),
                active: false,
            }],
            ..facts()
        };
        assert_eq!(link_target(&pending, "host_1", "per_a", KEY), mismatch);
        let nameless = PluginFacts {
            agents: vec![PluginAgent {
                id: String::new(),
                active: true,
            }],
            ..facts()
        };
        assert_eq!(link_target(&nameless, "host_1", "per_a", KEY), mismatch);
    }

    #[test]
    fn the_new_refusals_have_their_reason_codes() {
        assert_eq!(Refusal::NotRegistered.code(), "not_registered");
        assert_eq!(Refusal::BindingMismatch.code(), "binding_mismatch");
    }
}
