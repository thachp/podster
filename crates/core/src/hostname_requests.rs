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

/// What a room's removal of its custom hostname does to its open request (M6 step 8, `removeAppHostname`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Unmap {
    /// Nothing to do: the request is ending already, or over.
    Nothing,
    /// A pending request whose proof was never taken to the hostname's object: nobody was asked, so it is over at
    /// once, `ended`.
    Drop,
    /// A pending request whose proof was taken to the object, which may have given the claim: it goes `ending`, and is
    /// over only once the object has recorded it withdrawn ([`crate::hostnames::withdraw`]).
    Withdraw,
    /// A claim the room committed: it goes `ending`, the room stops serving on the name in the same transaction, and
    /// the claim ends as every claim does, deleted at Cloudflare and read until gone before it is freed.
    EndClaim,
}

/// The plan for a removal, from the request's state, whether its proof was taken to the object (`proof_asked`), and
/// whether the room committed a claim for it (`claimed`).
pub fn unmap(state: HostnameRequestState, proof_asked: bool, claimed: bool) -> Unmap {
    match state {
        HostnameRequestState::Pending if proof_asked => Unmap::Withdraw,
        HostnameRequestState::Pending => Unmap::Drop,
        HostnameRequestState::Claimed if claimed => Unmap::EndClaim,
        // A claimed request always has its claim committed. If one ever didn't, removing it must still end it, and
        // only the object can say whether a claim was given: withdraw.
        HostnameRequestState::Claimed => Unmap::Withdraw,
        _ => Unmap::Nothing,
    }
}

/// What the room records from the hostname object's answer to its ask.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AskOutcome {
    pub state: HostnameRequestState,
    /// The reason code for a request that is over.
    pub end_reason: Option<&'static str>,
}

/// The room's record of the object's answer, for a request that is still `pending`. `Suspended` and `Ending` make it
/// `ending` with no committed claim, so it is withdrawn at the object; any other refusal is final. **`None` for any
/// other state:**
/// the room removed it, or a notice set it ending, while the ask was out, so a claim given for it is withdrawn and
/// never committed.
pub fn after_ask(
    state: HostnameRequestState,
    decision: crate::hostnames::ClaimDecision,
) -> Option<AskOutcome> {
    use crate::hostnames::ClaimDecision as D;
    if state != HostnameRequestState::Pending {
        return None;
    }
    Some(match decision {
        D::Granted => AskOutcome {
            state: HostnameRequestState::Claimed,
            end_reason: None,
        },
        D::Expired => AskOutcome {
            state: HostnameRequestState::Expired,
            end_reason: Some(decision.code()),
        },
        // Decided before whose the claim is: the object may hold one it gave this very request, on an ask whose answer
        // was lost. Refused would leave it held for ever, so the request goes ending, never committed, and the job
        // withdraws it, which frees only a claim for exactly this room and request.
        D::Suspended | D::Ending => AskOutcome {
            state: HostnameRequestState::Ending,
            end_reason: Some(decision.code()),
        },
        _ => AskOutcome {
            state: HostnameRequestState::Refused,
            end_reason: Some(decision.code()),
        },
    })
}

/// **Proposed.** The shortest wait before an ask or a withdrawal that got no answer is tried again.
pub const RETRY_FIRST_MS: i64 = 60 * 1000;
/// **Proposed.** The longest. It is never given up.
pub const RETRY_MAX_MS: i64 = 60 * 60 * 1000;

/// How long the job waits after a try at `last_try` that got no answer, for a request whose last change was at `since`:
/// as long as has already gone by, from [`RETRY_FIRST_MS`] up to [`RETRY_MAX_MS`]. Tries at the minute, then two, four
/// and so on, so the wait doubles without a count to keep.
pub fn retry_wait_ms(since: i64, last_try: i64) -> i64 {
    last_try
        .saturating_sub(since)
        .clamp(RETRY_FIRST_MS, RETRY_MAX_MS)
}

/// **Proposed.** New custom hostname requests a room may make in any hour, whatever became of them.
pub const MAX_REQUESTS_PER_HOUR: usize = 5;

/// Whether a room that made `made_in_last_hour` requests in the hour before now may make another.
pub fn request_rate_allows(made_in_last_hour: usize) -> bool {
    made_in_last_hour < MAX_REQUESTS_PER_HOUR
}

// ---------------------------------------------------------------------------------------------------------------------
// The custom hostname at Cloudflare, and the long end of a committed claim (M6 step 8b)
// ---------------------------------------------------------------------------------------------------------------------

/// What a read of the custom hostname at Cloudflare, by its name, showed. Only a whole, well-formed answer is either of
/// the first two; anything else is `Unknown`, which settles nothing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProviderRead {
    /// Cloudflare holds a custom hostname of exactly this name. `moved` when its status is `moved`.
    Present { moved: bool },
    /// Cloudflare said, in a whole answer, that it holds none of this name.
    Gone,
    /// No answer, or one that isn't exactly the expected shape.
    Unknown,
}

/// What the job does for a request the room committed `claimed`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClaimedStep {
    /// Nothing was ever asked of Cloudflare for it: create the custom hostname, once the room's recheck allows.
    Create,
    /// A create was sent: read what Cloudflare holds, which settles a create whose answer was lost too.
    Read,
}

/// The step for a committed claim, from whether a create was ever sent, which the room records before it sends one.
pub fn claimed_step(create_sent: bool) -> ClaimedStep {
    if create_sent {
        ClaimedStep::Read
    } else {
        ClaimedStep::Create
    }
}

/// What a read of a committed claim's custom hostname does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AfterClaimedRead {
    /// It is there and not `moved`: the claim stays.
    Keep,
    /// The claim ends the long way, with this reason.
    End(crate::hostnames::ClaimEnd),
    /// Read as gone, and no ID was ever recorded for it: the create's answer was lost and nothing was made. It is
    /// created again, behind the same recheck as the first.
    CreateAgain,
    /// The read settled nothing: asked again later.
    Wait,
}

/// A read of a committed claim's custom hostname, given whether the room recorded its ID from an earlier answer.
pub fn after_claimed_read(read: ProviderRead, id_recorded: bool) -> AfterClaimedRead {
    use crate::hostnames::ClaimEnd;
    match read {
        ProviderRead::Unknown => AfterClaimedRead::Wait,
        ProviderRead::Present { moved: true } => AfterClaimedRead::End(ClaimEnd::Moved),
        ProviderRead::Present { moved: false } => AfterClaimedRead::Keep,
        ProviderRead::Gone if id_recorded => AfterClaimedRead::End(ClaimEnd::GoneAtProvider),
        ProviderRead::Gone => AfterClaimedRead::CreateAgain,
    }
}

/// What the job does next for a committed claim that is ending (ADR 0010's step 6).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EndStep {
    /// Tell the hostname's object the claim is ending, so it serves nothing and is never granted again.
    MarkEnding,
    /// Read what Cloudflare holds, deleting what is there, until a read reports it gone.
    Read,
    /// Free the claim at the object, and only then end the request.
    Free,
}

/// The long end's next step, from the room's own row: whether the object recorded the claim ending, whether a create
/// was ever sent to Cloudflare, and whether a read since reported the custom hostname gone. **A request for which no
/// create was ever sent has nothing at Cloudflare to delete,** since the room records that it is sending one, in its own
/// transaction, before it sends it.
pub fn end_step(object_ending: bool, create_sent: bool, gone: bool) -> EndStep {
    if !object_ending {
        EndStep::MarkEnding
    } else if create_sent && !gone {
        EndStep::Read
    } else {
        EndStep::Free
    }
}

/// What a read during the long end does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AfterEndRead {
    /// It is still there, whatever its status: delete it, and read again. A delete's own answer is never taken as gone.
    Delete,
    /// Cloudflare reports it gone: the claim may be freed.
    Gone,
    /// The read settled nothing: asked again later.
    Wait,
}

pub fn after_end_read(read: ProviderRead) -> AfterEndRead {
    match read {
        ProviderRead::Unknown => AfterEndRead::Wait,
        ProviderRead::Present { .. } => AfterEndRead::Delete,
        ProviderRead::Gone => AfterEndRead::Gone,
    }
}

/// Whether the room has unpublished since a request was made, from the room's release epoch when it was made and now,
/// which only an unpublish moves (ADR 0010: a claim ends when the room unpublishes). Either one unknown, or any
/// difference at all, ends it: fails closed.
pub fn unpublished_since(request_epoch: Option<u64>, epoch: Option<u64>) -> bool {
    match (request_epoch, epoch) {
        (Some(then), Some(now)) => then != now,
        _ => true,
    }
}

/// **Assumed, from Cloudflare's documented examples; no spike has seen one.** A custom hostname's ID: a UUID in lower
/// case. Nothing else is kept, or put into a path.
pub fn provider_id_form(id: &str) -> bool {
    let bytes = id.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(at, b)| match at {
            8 | 13 | 18 | 23 => *b == b'-',
            _ => b.is_ascii_digit() || (b'a'..=b'f').contains(b),
        })
}

/// A custom hostname's status as the room keeps it: lower-case letters and `_`, not long. Anything else isn't a status.
pub fn provider_status_form(status: &str) -> bool {
    (1..=32).contains(&status.len()) && status.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
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
