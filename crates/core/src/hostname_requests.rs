//! Where a room's request for a custom hostname stands (ADR 0010, custom domains; decision 207).
//!
//! The room keeps one row for each request it ever made, and this is that row's state. It is the room's own record:
//! the claim itself is the hostname's object's, in [`crate::hostnames`]. Added with M6 step 2, which stores the state
//! and names it in the contract, so that both take their names from here. Pure: names and two questions, no decisions.

/// A request's state.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HostnameRequestState {
    /// The challenge is out and nothing is held: a pending request reserves no name, and expires.
    Pending,
    /// The hostname's object gave this room the claim, for this request.
    Claimed,
    /// The claim is ending: the room has stopped serving on the name, and the claim is freed only once Cloudflare
    /// reports the custom hostname gone. It still counts against the room's one hostname.
    Ending,
    /// The hostname's object refused the claim, with [`crate::hostnames::ClaimDecision`]'s code.
    Refused,
    /// It was still pending after [`crate::hostnames::PENDING_TTL_MS`].
    Expired,
    /// It is over: dropped while pending, or its claim ended and was freed, with [`crate::hostnames::ClaimEnd`]'s code.
    Ended,
}

impl HostnameRequestState {
    pub fn name(self) -> &'static str {
        match self {
            HostnameRequestState::Pending => "pending",
            HostnameRequestState::Claimed => "claimed",
            HostnameRequestState::Ending => "ending",
            HostnameRequestState::Refused => "refused",
            HostnameRequestState::Expired => "expired",
            HostnameRequestState::Ended => "ended",
        }
    }

    pub const ALL: [HostnameRequestState; 6] = [
        HostnameRequestState::Pending,
        HostnameRequestState::Claimed,
        HostnameRequestState::Ending,
        HostnameRequestState::Refused,
        HostnameRequestState::Expired,
        HostnameRequestState::Ended,
    ];

    pub fn parse(value: &str) -> Option<HostnameRequestState> {
        Self::ALL.into_iter().find(|state| state.name() == value)
    }

    /// Whether the request still counts against [`crate::hostnames::MAX_HOSTNAMES_PER_ROOM`]: the room can't ask for
    /// another name while one is open.
    pub fn is_open(self) -> bool {
        matches!(
            self,
            HostnameRequestState::Pending
                | HostnameRequestState::Claimed
                | HostnameRequestState::Ending
        )
    }

    /// Nothing moves a request out of these.
    pub fn is_final(self) -> bool {
        !self.is_open()
    }
}

/// Where a claim stands in the hostname's own object, which keeps every claim there has been. Core's
/// [`crate::hostnames::HostnameRecord`] is what the object decides from: `Live` and `Ending` are its `claim` with
/// `ending` false and true, and `Ended` is a claim that was freed and holds nothing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HostnameClaimState {
    Live,
    Ending,
    Ended,
}

impl HostnameClaimState {
    pub fn name(self) -> &'static str {
        match self {
            HostnameClaimState::Live => "live",
            HostnameClaimState::Ending => "ending",
            HostnameClaimState::Ended => "ended",
        }
    }

    pub const ALL: [HostnameClaimState; 3] = [
        HostnameClaimState::Live,
        HostnameClaimState::Ending,
        HostnameClaimState::Ended,
    ];

    /// Whether the claim holds the name: nobody else is given it until it is freed.
    pub fn holds(self) -> bool {
        matches!(self, HostnameClaimState::Live | HostnameClaimState::Ending)
    }
}

#[cfg(test)]
mod tests {
    use super::HostnameRequestState;

    #[test]
    fn every_state_has_its_own_name_and_parses_back() {
        let names: Vec<&str> = HostnameRequestState::ALL
            .iter()
            .map(|state| state.name())
            .collect();
        for (at, name) in names.iter().enumerate() {
            assert_eq!(
                HostnameRequestState::parse(name),
                HostnameRequestState::ALL.get(at).copied()
            );
            assert_eq!(names.iter().filter(|other| other == &name).count(), 1);
        }
        assert_eq!(HostnameRequestState::parse("Pending"), None);
        assert_eq!(HostnameRequestState::parse(""), None);
    }

    #[test]
    fn a_claim_holds_the_name_until_it_is_ended() {
        use super::HostnameClaimState;
        let holding: Vec<&str> = HostnameClaimState::ALL
            .iter()
            .filter(|state| state.holds())
            .map(|state| state.name())
            .collect();
        assert_eq!(holding, ["live", "ending"]);
    }

    #[test]
    fn open_is_exactly_pending_claimed_and_ending() {
        let open: Vec<&str> = HostnameRequestState::ALL
            .iter()
            .filter(|state| state.is_open())
            .map(|state| state.name())
            .collect();
        assert_eq!(open, ["pending", "claimed", "ending"]);
        for state in HostnameRequestState::ALL {
            assert_ne!(state.is_open(), state.is_final());
        }
    }
}
