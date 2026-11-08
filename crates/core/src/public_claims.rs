//! Limits on public claims: M4 step 2. No I/O.
//!
//! Decision 162, as amended by the ADR 0008 review. Every limit here is exact, and the caller fails closed: a count it
//! couldn't read is a refusal, never a pass. The counts live in different places, and each place checks its own:
//!
//! - **The room** counts its public claims in the last hour, and holds the owner's block on organizations.
//! - **The agent's `Principal`** counts its public claims now active, across rooms.
//! - **The linking person's `Principal`** counts public claims now active by every agent that person linked, across all
//!   their organizations.
//! - **`StrictCounter`** in the gateway counts claims in the last hour per agent, per person and per organization.
//!
//! Only public claims count. A claim through an invitation, or an owner or admin naming an agent, never does.
//!
//! An attacker with enough agents can use up a room's hourly limit and keep real claimants out for that hour. That's
//! accepted: pausing public claims and blocking agents or organizations are the room owner's answers.

/// Public claims one agent may hold at once, across every room.
pub const MAX_AGENT_ACTIVE_PUBLIC_CLAIMS: u32 = 3;
/// Public claims one agent may make in an hour.
pub const MAX_AGENT_PUBLIC_CLAIMS_PER_HOUR: u32 = 5;
/// Public claims held at once by every agent one person linked, across all their organizations.
pub const MAX_PERSON_ACTIVE_PUBLIC_CLAIMS: u32 = 3;
/// Public claims made in an hour by every agent one person linked, across all their organizations.
pub const MAX_PERSON_PUBLIC_CLAIMS_PER_HOUR: u32 = 5;
/// Public claims one organization's agents may make in an hour.
pub const MAX_ORG_PUBLIC_CLAIMS_PER_HOUR: u32 = 20;
/// Public claims one room may take in an hour.
pub const MAX_ROOM_PUBLIC_CLAIMS_PER_HOUR: u32 = 20;
/// The window the hourly limits count over, in seconds.
pub const PUBLIC_CLAIM_WINDOW_SECS: i64 = 60 * 60;

/// Why a public claim was refused by a limit or a block. It carries no IDs or counts, so it's safe to log.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PublicClaimLimit {
    AgentActive,
    AgentHourly,
    PersonActive,
    PersonHourly,
    OrgHourly,
    RoomHourly,
    /// The room's owner or an admin blocked the agent's organization from public claims.
    OrgBlocked,
}

impl PublicClaimLimit {
    pub fn code(self) -> &'static str {
        match self {
            PublicClaimLimit::OrgBlocked => "not_allowed",
            _ => "limit_exceeded",
        }
    }

    /// A stable reason code for audit and denial records.
    pub fn reason(self) -> &'static str {
        match self {
            PublicClaimLimit::AgentActive => "public_claims.agent_active",
            PublicClaimLimit::AgentHourly => "public_claims.agent_hourly",
            PublicClaimLimit::PersonActive => "public_claims.person_active",
            PublicClaimLimit::PersonHourly => "public_claims.person_hourly",
            PublicClaimLimit::OrgHourly => "public_claims.org_hourly",
            PublicClaimLimit::RoomHourly => "public_claims.room_hourly",
            PublicClaimLimit::OrgBlocked => "public_claims.org_blocked",
        }
    }
}

fn below(count: u32, max: u32, refusal: PublicClaimLimit) -> Result<(), PublicClaimLimit> {
    if count < max {
        Ok(())
    } else {
        Err(refusal)
    }
}

/// The room's own checks, in its claim transaction: the owner's block first, then its hourly limit.
/// `claims_last_hour` counts only public claims, ended ones included, since ending a claim doesn't give the hour back.
pub fn check_room(org_blocked: bool, claims_last_hour: u32) -> Result<(), PublicClaimLimit> {
    if org_blocked {
        return Err(PublicClaimLimit::OrgBlocked);
    }
    below(
        claims_last_hour,
        MAX_ROOM_PUBLIC_CLAIMS_PER_HOUR,
        PublicClaimLimit::RoomHourly,
    )
}

/// The agent's `Principal`: its public claims active now, across rooms.
pub fn check_agent_active(active: u32) -> Result<(), PublicClaimLimit> {
    below(
        active,
        MAX_AGENT_ACTIVE_PUBLIC_CLAIMS,
        PublicClaimLimit::AgentActive,
    )
}

/// The linking person's `Principal`: public claims active now by every agent they linked.
pub fn check_person_active(active: u32) -> Result<(), PublicClaimLimit> {
    below(
        active,
        MAX_PERSON_ACTIVE_PUBLIC_CLAIMS,
        PublicClaimLimit::PersonActive,
    )
}

/// The hourly counts kept by `StrictCounter`, before the claim is attempted.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct HourlyCounts {
    pub agent: u32,
    pub person: u32,
    pub org: u32,
}

/// `StrictCounter`'s checks, agent first, then person, then organization.
pub fn check_hourly(counts: HourlyCounts) -> Result<(), PublicClaimLimit> {
    below(
        counts.agent,
        MAX_AGENT_PUBLIC_CLAIMS_PER_HOUR,
        PublicClaimLimit::AgentHourly,
    )?;
    below(
        counts.person,
        MAX_PERSON_PUBLIC_CLAIMS_PER_HOUR,
        PublicClaimLimit::PersonHourly,
    )?;
    below(
        counts.org,
        MAX_ORG_PUBLIC_CLAIMS_PER_HOUR,
        PublicClaimLimit::OrgHourly,
    )
}

/// How many of these claim times fall in the hour up to `now`, for a room counting from its own rows. A time in the
/// future counts, so a clock step backwards can't free the hour.
pub fn claims_in_window(claimed_at: &[i64], now: i64) -> u32 {
    let since = now.saturating_sub(PUBLIC_CLAIM_WINDOW_SECS);
    let n = claimed_at.iter().filter(|&&at| at > since).count();
    u32::try_from(n).unwrap_or(u32::MAX)
}
