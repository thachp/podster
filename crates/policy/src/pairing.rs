//! Who may start, read, cancel and confirm a Runner pairing session (M7 step 5(a); decision 222; RUNNER.md "Pairing
//! security and approval gates"). No I/O. Denies by default.
//!
//! Only a person acts on a session, and only the person who started it, so agent text can never stand in for human
//! consent. Starting and confirming take a current admin of the session's organization. Confirming also takes an unbroken
//! membership since the session started: someone who left and came back, or whose admin role was taken away, while the
//! session waited, can't confirm it. Runner's redemption isn't here: it carries no identity, only a code and a key whose
//! possession the gateway checked, and `podster_core::pairing` decides it.

use crate::PrincipalKind;

/// What the gateway says of the caller, for one organization.
#[derive(Clone, Copy, Debug)]
pub struct Person<'a> {
    pub kind: PrincipalKind,
    pub id: &'a str,
    /// Whether they administer the organization now.
    pub administers: bool,
    /// When their current membership of it began, in milliseconds, if they're a member.
    pub member_since: Option<i64>,
}

/// A person who administers the organization now.
pub fn may_start(caller: &Person) -> bool {
    caller.kind == PrincipalKind::Person && caller.administers
}

/// The person who started it, whatever their role now, so someone who lost their role can still see it ended or end it.
pub fn may_read_or_cancel(caller: &Person, starter: &str) -> bool {
    caller.kind == PrincipalKind::Person && !starter.is_empty() && caller.id == starter
}

/// The person who started it, still an admin of its organization, in a membership that began no later than the session.
pub fn may_activate(caller: &Person, starter: &str, started_at: i64) -> bool {
    may_read_or_cancel(caller, starter)
        && caller.administers
        && caller.member_since.is_some_and(|since| since <= started_at)
}

#[cfg(test)]
mod tests {
    use super::*;

    const STARTED: i64 = 5_000;

    fn admin() -> Person<'static> {
        Person {
            kind: PrincipalKind::Person,
            id: "per_a",
            administers: true,
            member_since: Some(1_000),
        }
    }

    #[test]
    fn only_a_person_who_administers_starts() {
        assert!(may_start(&admin()));
        assert!(!may_start(&Person {
            administers: false,
            ..admin()
        }));
        assert!(!may_start(&Person {
            kind: PrincipalKind::Agent,
            ..admin()
        }));
    }

    #[test]
    fn only_the_starter_reads_or_cancels_even_after_losing_the_role() {
        assert!(may_read_or_cancel(&admin(), "per_a"));
        assert!(may_read_or_cancel(
            &Person {
                administers: false,
                member_since: None,
                ..admin()
            },
            "per_a"
        ));
        assert!(!may_read_or_cancel(&admin(), "per_b"));
        assert!(!may_read_or_cancel(&admin(), ""));
        assert!(!may_read_or_cancel(
            &Person {
                kind: PrincipalKind::Agent,
                ..admin()
            },
            "per_a"
        ));
    }

    #[test]
    fn confirming_takes_the_starter_still_an_admin_since_before_the_start() {
        assert!(may_activate(&admin(), "per_a", STARTED));
        assert!(may_activate(
            &Person {
                member_since: Some(STARTED),
                ..admin()
            },
            "per_a",
            STARTED
        ));
        // Someone else, even an admin of the organization.
        assert!(!may_activate(&admin(), "per_b", STARTED));
        // No longer an admin.
        assert!(!may_activate(
            &Person {
                administers: false,
                ..admin()
            },
            "per_a",
            STARTED
        ));
        // Left and came back while it waited.
        assert!(!may_activate(
            &Person {
                member_since: Some(STARTED + 1),
                ..admin()
            },
            "per_a",
            STARTED
        ));
        // Not a member at all.
        assert!(!may_activate(
            &Person {
                member_since: None,
                ..admin()
            },
            "per_a",
            STARTED
        ));
        // An agent, whatever it says.
        assert!(!may_activate(
            &Person {
                kind: PrincipalKind::Agent,
                ..admin()
            },
            "per_a",
            STARTED
        ));
    }
}
