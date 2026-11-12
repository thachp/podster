//! A custom hostname for a room's app: the name's normalization and refusals, the room-bound challenge, the one claim
//! per hostname, its recheck, and suspension (ADR 0010, custom domains; decisions 201 and 207). Pure, with no I/O and
//! no clock: every time is passed in, in milliseconds.
//!
//! Podster's own proof comes before any claim and before Cloudflare is asked. Cloudflare's validation alone isn't proof.

use std::net::{IpAddr, Ipv4Addr};

/// The longest hostname, in its ASCII form.
pub const MAX_HOSTNAME_LEN: usize = 253;
/// The longest label of a hostname.
pub const MAX_HOSTNAME_LABEL_LEN: usize = 63;
/// Podster's own domain. Neither it nor anything under it may be mapped.
pub const PODSTER_DOMAIN: &str = "podster.dev";
/// The name the challenge's TXT record goes at, before the hostname.
pub const CHALLENGE_PREFIX: &str = "_podster-challenge";
/// How long a pending request lives. Pending holds nothing.
pub const PENDING_TTL_MS: i64 = 72 * 60 * 60 * 1000;
/// How often a live claim's challenge is checked again.
pub const RECHECK_INTERVAL_MS: i64 = 24 * 60 * 60 * 1000;
/// Two definite noes at least this far apart end a claim.
pub const DEFINITE_NO_SPAN_MS: i64 = 24 * 60 * 60 * 1000;
/// A claim with no successful proof for this long ends, whatever the resolver said.
pub const NO_PROOF_LIMIT_MS: i64 = 7 * 24 * 60 * 60 * 1000;
/// Custom hostnames a room may have, pending or claimed.
pub const MAX_HOSTNAMES_PER_ROOM: usize = 1;

/// Why a hostname can't be mapped.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HostnameRefusal {
    /// `hostname_invalid`: not a hostname, after normalization.
    Invalid,
    /// `hostname_wildcard`
    Wildcard,
    /// `hostname_ip_address`
    IpAddress,
    /// `hostname_single_label`
    SingleLabel,
    /// `hostname_reserved`: `podster.dev`, the content domain, or a name under either.
    Reserved,
    /// `hostname_public_suffix`: a public suffix itself.
    PublicSuffix,
    /// `hostname_suspended`: an operator suspended it, and only an operator lifts that.
    Suspended,
    /// `hostname_limit`: the room already has its one custom hostname, pending or claimed.
    RoomLimit,
}

impl HostnameRefusal {
    // codes: reasons
    pub fn code(self) -> &'static str {
        match self {
            HostnameRefusal::Invalid => "hostname_invalid",
            HostnameRefusal::Wildcard => "hostname_wildcard",
            HostnameRefusal::IpAddress => "hostname_ip_address",
            HostnameRefusal::SingleLabel => "hostname_single_label",
            HostnameRefusal::Reserved => "hostname_reserved",
            HostnameRefusal::PublicSuffix => "hostname_public_suffix",
            HostnameRefusal::Suspended => "hostname_suspended",
            HostnameRefusal::RoomLimit => "hostname_limit",
        }
    }
}

/// One name for every spelling of it: lower case, one trailing dot removed, and an international name in its ASCII form
/// by IDNA (UTS 46, non-transitional). Then it must be a hostname: labels of 1 to 63 letters, digits and hyphens, not
/// beginning or ending with a hyphen, at most 253 characters in all. A wildcard is refused before IDNA sees it.
pub fn normalize(input: &str) -> Result<String, HostnameRefusal> {
    if input.contains('*') {
        return Err(HostnameRefusal::Wildcard);
    }
    if input.is_empty() || input.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(HostnameRefusal::Invalid);
    }
    let trimmed = input.strip_suffix('.').unwrap_or(input);
    if trimmed.is_empty() || trimmed.ends_with('.') {
        return Err(HostnameRefusal::Invalid);
    }
    if is_ip_address(trimmed) {
        return Err(HostnameRefusal::IpAddress);
    }
    let ascii = idna::domain_to_ascii(trimmed).map_err(|_| HostnameRefusal::Invalid)?;
    if ascii.len() > MAX_HOSTNAME_LEN || ascii.contains('*') {
        return Err(HostnameRefusal::Invalid);
    }
    for label in ascii.split('.') {
        let ok = (1..=MAX_HOSTNAME_LABEL_LEN).contains(&label.len())
            && label
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
            && !label.starts_with('-')
            && !label.ends_with('-');
        if !ok {
            return Err(HostnameRefusal::Invalid);
        }
    }
    if is_ip_address(&ascii) {
        return Err(HostnameRefusal::IpAddress);
    }
    Ok(ascii)
}

/// An IPv4 address in any spelling `std` reads, an IPv6 address bare or in brackets, or a name whose last label is all
/// digits, which some resolvers read as an address.
fn is_ip_address(name: &str) -> bool {
    let bare = name.trim_start_matches('[').trim_end_matches(']');
    bare.parse::<IpAddr>().is_ok()
        || bare.parse::<Ipv4Addr>().is_ok()
        || name
            .rsplit('.')
            .next()
            .is_some_and(|last| !last.is_empty() && last.bytes().all(|b| b.is_ascii_digit()))
}

/// Whether `name` is `domain` or under it.
fn is_or_under(name: &str, domain: &str) -> bool {
    name == domain || name.ends_with(&format!(".{domain}"))
}

/// A hostname a room may ask to map, normalized. `content_domain` is the deployment's, from its configuration.
/// `public_suffixes` are the suffixes the deployment holds from the Public Suffix List, normalized; a name equal to one
/// is refused. `suspended` is the hostname's own claim object's answer. `room_hostnames` is how many the room has,
/// pending or claimed.
pub fn mappable(
    input: &str,
    content_domain: &str,
    public_suffixes: &[&str],
    suspended: bool,
    room_hostnames: usize,
) -> Result<String, HostnameRefusal> {
    let name = normalize(input)?;
    if !name.contains('.') {
        return Err(HostnameRefusal::SingleLabel);
    }
    if is_or_under(&name, PODSTER_DOMAIN) || is_or_under(&name, content_domain) {
        return Err(HostnameRefusal::Reserved);
    }
    if public_suffixes.iter().any(|suffix| *suffix == name) {
        return Err(HostnameRefusal::PublicSuffix);
    }
    if suspended {
        return Err(HostnameRefusal::Suspended);
    }
    if room_hostnames >= MAX_HOSTNAMES_PER_ROOM {
        return Err(HostnameRefusal::RoomLimit);
    }
    Ok(name)
}

// ---------------------------------------------------------------------------------------------------------------------
// The challenge
// ---------------------------------------------------------------------------------------------------------------------

/// Where the room's owner publishes the challenge: `_podster-challenge.<hostname>`.
pub fn challenge_record_name(hostname: &str) -> String {
    format!("{CHALLENGE_PREFIX}.{hostname}")
}

/// The challenge's value, made for one request alone from 32 random bytes the caller supplies: lower-case hexadecimal,
/// naming nothing readable.
pub fn challenge_value(random: [u8; 32]) -> String {
    random.iter().map(|b| format!("{b:02x}")).collect()
}

/// Whether the TXT record proves the request: any one of its values equal to the request's value, exactly. Other values
/// beside it don't matter, so two rooms proving at once don't overwrite each other. Each value is one TXT string, its
/// chunks joined and its quotes removed by the caller.
pub fn proof_matches(values: &[&str], expected: &str) -> bool {
    !expected.is_empty() && values.contains(&expected)
}

/// Whether a pending request has expired: 72 hours after it was made. An expired request is gone.
pub fn pending_expired(requested_at: i64, now: i64) -> bool {
    now.saturating_sub(requested_at) >= PENDING_TTL_MS
}

// ---------------------------------------------------------------------------------------------------------------------
// The claim
// ---------------------------------------------------------------------------------------------------------------------

/// A live claim, as the hostname's own object holds it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Claim<'a> {
    pub room: &'a str,
    /// The room's request whose proof won the claim.
    pub request: &'a str,
}

/// What the hostname's object holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HostnameRecord<'a> {
    pub claim: Option<Claim<'a>>,
    pub suspended: bool,
    /// When the last claim was freed, after Cloudflare reported its custom hostname gone.
    pub last_freed_at: Option<i64>,
}

/// A room's ask for the claim, after its proof matched.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ClaimAsk<'a> {
    pub room: &'a str,
    pub request: &'a str,
    /// When the request, and so its challenge, was made.
    pub requested_at: i64,
    /// The proof matched, just now, for this request's own value.
    pub proof_matched: bool,
}

/// The claim object's answer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClaimDecision {
    /// The room now holds the claim, or already did for this same request: asking again gets the same answer.
    Granted,
    /// `hostname_claimed`: another room holds it, or this room holds it under another request.
    HeldElsewhere,
    /// `hostname_suspended`
    Suspended,
    /// `hostname_unproven`: no matching proof for this request.
    Unproven,
    /// `hostname_challenge_stale`: the challenge was made before the last claim was freed. A claim never transfers: a
    /// later claim, by anyone, needs a new challenge with a new value.
    StaleChallenge,
    /// `hostname_request_expired`: the request is past its 72 hours.
    Expired,
}

impl ClaimDecision {
    // codes: reasons
    pub fn code(self) -> &'static str {
        match self {
            ClaimDecision::Granted => "granted",
            ClaimDecision::HeldElsewhere => "hostname_claimed",
            ClaimDecision::Suspended => "hostname_suspended",
            ClaimDecision::Unproven => "hostname_unproven",
            ClaimDecision::StaleChallenge => "hostname_challenge_stale",
            ClaimDecision::Expired => "hostname_request_expired",
        }
    }
}

/// The hostname object's decision on a room's ask. One hostname, one room: the first room whose proof passed gets it,
/// and any other is refused while that claim lives. Suspension comes first, and outlives every claim.
pub fn decide_claim(record: &HostnameRecord, ask: &ClaimAsk, now: i64) -> ClaimDecision {
    if record.suspended {
        return ClaimDecision::Suspended;
    }
    if let Some(claim) = record.claim {
        return if claim.room == ask.room && claim.request == ask.request {
            ClaimDecision::Granted
        } else {
            ClaimDecision::HeldElsewhere
        };
    }
    if pending_expired(ask.requested_at, now) {
        return ClaimDecision::Expired;
    }
    if record
        .last_freed_at
        .is_some_and(|freed| ask.requested_at <= freed)
    {
        return ClaimDecision::StaleChallenge;
    }
    if !ask.proof_matched {
        return ClaimDecision::Unproven;
    }
    ClaimDecision::Granted
}

/// Whether a claim may be freed: only after the room cleared that host's desired serve state, and Cloudflare reported
/// the custom hostname gone. Until both, the claim holds and nobody else can get it.
pub fn may_free_claim(serve_cleared: bool, cloudflare_reports_gone: bool) -> bool {
    serve_cleared && cloudflare_reports_gone
}

/// Whether a host may be served on a custom hostname: the room's desired state names a script for it, and the claim
/// object says that room holds it. Both must agree; the applier asks both before it writes, and the reconcile too.
pub fn custom_host_may_serve(room_wants_a_script: bool, claim: Option<Claim>, room: &str) -> bool {
    room_wants_a_script && claim.is_some_and(|c| c.room == room)
}

// ---------------------------------------------------------------------------------------------------------------------
// The recheck
// ---------------------------------------------------------------------------------------------------------------------

/// What one recheck of a live claim's challenge saw.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RecheckOutcome {
    /// The value is there.
    Match,
    /// The name's own authoritative servers answered, and the value isn't there.
    DefiniteNo,
    /// The resolver failed, timed out, or couldn't reach the name's servers.
    ResolverError,
}

/// A live claim's proof history.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProofHistory {
    /// The last time the proof matched: when the claim was granted, then at each matching recheck.
    pub last_success_at: i64,
    /// The first definite no since that success, if there was one.
    pub definite_no_since: Option<i64>,
}

/// What a recheck does to the claim.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RecheckDecision {
    Keep(ProofHistory),
    /// End the claim, with the reason's code.
    End(ClaimEnd),
}

/// Why a claim ends.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClaimEnd {
    /// `hostname_challenge_removed`: two definite noes at least 24 hours apart, with no match between.
    ChallengeRemoved,
    /// `hostname_proof_lapsed`: no successful proof for 7 days.
    ProofLapsed,
    /// `hostname_moved`: Cloudflare reports the hostname `moved`.
    Moved,
    /// `hostname_unmapped`: the room removed the mapping.
    Unmapped,
    /// `hostname_unpublished`: the room's app was unpublished.
    Unpublished,
    /// `hostname_suspended`: an operator suspended the hostname.
    Suspended,
}

impl ClaimEnd {
    // codes: reasons
    pub fn code(self) -> &'static str {
        match self {
            ClaimEnd::ChallengeRemoved => "hostname_challenge_removed",
            ClaimEnd::ProofLapsed => "hostname_proof_lapsed",
            ClaimEnd::Moved => "hostname_moved",
            ClaimEnd::Unmapped => "hostname_unmapped",
            ClaimEnd::Unpublished => "hostname_unpublished",
            ClaimEnd::Suspended => "hostname_suspended",
        }
    }
}

/// Whether a claim's daily recheck is due.
pub fn recheck_due(last_checked_at: i64, now: i64) -> bool {
    now.saturating_sub(last_checked_at) >= RECHECK_INTERVAL_MS
}

/// One recheck. A match resets both clocks. A definite no starts the 24-hour span, or ends the claim if one began at
/// least 24 hours ago. A resolver error never ends a claim by itself, since Podster's own trouble mustn't take a
/// customer's domain down. And any outcome but a match ends a claim with no success for 7 days.
pub fn recheck_claim(history: ProofHistory, outcome: RecheckOutcome, now: i64) -> RecheckDecision {
    if outcome == RecheckOutcome::Match {
        return RecheckDecision::Keep(ProofHistory {
            last_success_at: now,
            definite_no_since: None,
        });
    }
    if outcome == RecheckOutcome::DefiniteNo {
        if let Some(since) = history.definite_no_since {
            if now.saturating_sub(since) >= DEFINITE_NO_SPAN_MS {
                return RecheckDecision::End(ClaimEnd::ChallengeRemoved);
            }
        }
    }
    if now.saturating_sub(history.last_success_at) >= NO_PROOF_LIMIT_MS {
        return RecheckDecision::End(ClaimEnd::ProofLapsed);
    }
    let definite_no_since = match outcome {
        RecheckOutcome::DefiniteNo => Some(history.definite_no_since.unwrap_or(now)),
        _ => history.definite_no_since,
    };
    RecheckDecision::Keep(ProofHistory {
        last_success_at: history.last_success_at,
        definite_no_since,
    })
}

/// Cloudflare's status for the custom hostname: `moved` ends the claim; Podster doesn't wait for Cloudflare's own
/// deletion after seven days.
pub fn cloudflare_status_ends_claim(status: &str) -> Option<ClaimEnd> {
    (status == "moved").then_some(ClaimEnd::Moved)
}

/// Whether the host may start serving: the room holds the claim and Cloudflare reports the hostname `active`.
pub fn routing_may_start(room_holds_claim: bool, cloudflare_status: &str) -> bool {
    room_holds_claim && cloudflare_status == "active"
}

// ---------------------------------------------------------------------------------------------------------------------
// Suspension
// ---------------------------------------------------------------------------------------------------------------------

/// What an operator's suspension of a hostname does, in its object.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SuspendPlan<'a> {
    /// The room that held a live claim, which must clear that host's desired serve state at once, by a message the
    /// object keeps and sends again until the room answers. The claim then ends as any claim does.
    pub tell_room: Option<&'a str>,
}

/// Suspending a hostname: it stays suspended through and after any claim, and the room holding one is told.
pub fn suspend<'a>(record: &HostnameRecord<'a>) -> (HostnameRecord<'a>, SuspendPlan<'a>) {
    (
        HostnameRecord {
            claim: record.claim,
            suspended: true,
            last_freed_at: record.last_freed_at,
        },
        SuspendPlan {
            tell_room: record.claim.map(|c| c.room),
        },
    )
}

/// Lifting a suspension restores nothing: no claim comes back, and a room must challenge anew.
pub fn lift<'a>(record: &HostnameRecord<'a>) -> HostnameRecord<'a> {
    HostnameRecord {
        claim: record.claim,
        suspended: false,
        last_freed_at: record.last_freed_at,
    }
}

/// Freeing a claim once [`may_free_claim`] holds: the record keeps its suspension and remembers when, so any later claim
/// needs a challenge made after now.
pub fn free<'a>(record: &HostnameRecord<'a>, now: i64) -> HostnameRecord<'a> {
    HostnameRecord {
        claim: None,
        suspended: record.suspended,
        last_freed_at: Some(now),
    }
}
