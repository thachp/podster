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
    /// `hostname_unavailable`: the deployment's own configuration can't classify the name: the content domain or the
    /// Public Suffix List rules are missing or malformed, or no rule covers the name's top-level label. Fails closed.
    Unclassified,
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
            HostnameRefusal::Unclassified => "hostname_unavailable",
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

/// An IP literal (IPv4 in any spelling `std` reads, IPv6 bare or in brackets), or a name whose last label looks like a
/// number in any base: all decimal digits, or `0x` followed by hexadecimal digits, or `0` followed by octal digits.
/// Browsers and resolvers read such names as addresses (`0x4`, `1.2.3.0x4`). Ruled on the review of PR #309.
fn is_ip_address(name: &str) -> bool {
    let bare = name.trim_start_matches('[').trim_end_matches(']');
    bare.parse::<IpAddr>().is_ok()
        || bare.parse::<Ipv4Addr>().is_ok()
        || name.rsplit('.').next().is_some_and(is_number)
}

/// A label that reads as a number: decimal, `0x`/`0X` hexadecimal (an empty tail included), or octal.
fn is_number(label: &str) -> bool {
    if label.is_empty() {
        return false;
    }
    if let Some(hex) = label
        .strip_prefix("0x")
        .or_else(|| label.strip_prefix("0X"))
    {
        return hex.bytes().all(|b| b.is_ascii_hexdigit());
    }
    label.bytes().all(|b| b.is_ascii_digit())
}

/// One rule of the Public Suffix List, as the deployment holds it: a plain rule (`co.uk`), a wildcard (`*.ck`), or an
/// exception (`!www.ck`).
#[derive(Clone, Debug, PartialEq, Eq)]
enum SuffixRule {
    Plain(Vec<String>),
    Wildcard(Vec<String>),
    Exception(Vec<String>),
}

/// A rule's labels, normalized like a hostname. `None` for a rule that can't be read.
fn suffix_rule(rule: &str) -> Option<SuffixRule> {
    let labels = |body: &str| -> Option<Vec<String>> {
        let ascii = idna::domain_to_ascii(body).ok()?;
        (!ascii.is_empty() && ascii.split('.').all(|l| !l.is_empty()))
            .then(|| ascii.split('.').map(str::to_owned).collect())
    };
    if let Some(body) = rule.strip_prefix('!') {
        return labels(body)
            .filter(|l| l.len() >= 2)
            .map(SuffixRule::Exception);
    }
    if let Some(body) = rule.strip_prefix("*.") {
        return labels(body).map(SuffixRule::Wildcard);
    }
    if rule.contains('*') || rule.contains('!') {
        return None;
    }
    labels(rule).map(SuffixRule::Plain)
}

/// How many of a name's labels, from the right, are its public suffix under these rules, by the list's algorithm: the
/// longest matching rule prevails, an exception rule prevails over all and stands for one label fewer, and a wildcard
/// stands for one label more. `None` when the rules can't be read, or no rule covers the name's top-level label, which
/// fails closed rather than falling back to the list's default rule.
fn public_suffix_len(name: &[&str], rules: &[SuffixRule]) -> Option<usize> {
    let ends_with = |labels: &[String]| {
        labels.len() <= name.len()
            && name
                .iter()
                .rev()
                .zip(labels.iter().rev())
                .all(|(n, r)| n == r)
    };
    let mut best: Option<usize> = None;
    for rule in rules {
        match rule {
            SuffixRule::Exception(labels) if ends_with(labels) => return Some(labels.len() - 1),
            SuffixRule::Plain(labels) if ends_with(labels) => best = best.max(Some(labels.len())),
            SuffixRule::Wildcard(labels) if ends_with(labels) && name.len() > labels.len() => {
                best = best.max(Some(labels.len() + 1));
            }
            // A wildcard whose base is the whole name covers the name's top-level label without matching it.
            SuffixRule::Wildcard(labels) if ends_with(labels) => {
                best = best.max(Some(labels.len()))
            }
            _ => {}
        }
    }
    best
}

/// Whether `name` is `domain` or under it.
fn is_or_under(name: &str, domain: &str) -> bool {
    name == domain || name.ends_with(&format!(".{domain}"))
}

/// A hostname a room may ask to map, normalized. `content_domain` is the deployment's, from its configuration, and is
/// normalized here too; an empty or malformed one fails closed. `public_suffix_rules` are the Public Suffix List's rules
/// the deployment holds, as the list writes them (`co.uk`, `*.ck`, `!www.ck`); a name that is itself a public suffix
/// under them, a wildcard rule's included, is refused, and so is a name no rule covers. `suspended` is the hostname's
/// own claim object's answer. `room_hostnames` is how many the room has, pending or claimed.
pub fn mappable(
    input: &str,
    content_domain: &str,
    public_suffix_rules: &[&str],
    suspended: bool,
    room_hostnames: usize,
) -> Result<String, HostnameRefusal> {
    let name = normalize(input)?;
    if !name.contains('.') {
        return Err(HostnameRefusal::SingleLabel);
    }
    let content = normalize(content_domain).map_err(|_| HostnameRefusal::Unclassified)?;
    if !content.contains('.') {
        return Err(HostnameRefusal::Unclassified);
    }
    if is_or_under(&name, PODSTER_DOMAIN) || is_or_under(&name, &content) {
        return Err(HostnameRefusal::Reserved);
    }
    let rules: Option<Vec<SuffixRule>> =
        public_suffix_rules.iter().map(|r| suffix_rule(r)).collect();
    let rules = rules
        .filter(|r| !r.is_empty())
        .ok_or(HostnameRefusal::Unclassified)?;
    let labels: Vec<&str> = name.split('.').collect();
    let suffix = public_suffix_len(&labels, &rules).ok_or(HostnameRefusal::Unclassified)?;
    if suffix >= labels.len() {
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
    /// The claim is ending: by its recheck, Cloudflare's `moved`, the room unpublishing or unmapping, or suspension. It
    /// serves nothing from here, and holds the name until Cloudflare reports the custom hostname gone and it is freed.
    pub ending: bool,
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
    /// `hostname_claim_ending`: the claim is ending, and is never granted again, not even to its own room and request.
    /// Once it is freed, any claim needs a new challenge.
    Ending,
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
            ClaimDecision::Ending => "hostname_claim_ending",
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
        return if record.ending {
            ClaimDecision::Ending
        } else if claim.room == ask.room && claim.request == ask.request {
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
/// object says that room holds a live claim on a name that isn't suspended. A claim that is ending serves nothing. Both
/// sides must agree; the applier asks both before it writes, and the reconcile too.
pub fn custom_host_may_serve(
    room_wants_a_script: bool,
    record: &HostnameRecord,
    room: &str,
) -> bool {
    room_wants_a_script
        && !record.suspended
        && !record.ending
        && record.claim.is_some_and(|c| c.room == room)
}

/// The claim starts ending, for any reason in [`ClaimEnd`]: the room clears and closes that host
/// (`release::clear_host`), the custom hostname is deleted at Cloudflare and read until gone, and only then is the claim
/// freed ([`may_free_claim`], [`free`]).
pub fn end_claim<'a>(record: &HostnameRecord<'a>) -> HostnameRecord<'a> {
    HostnameRecord {
        ending: record.claim.is_some(),
        ..*record
    }
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

/// Suspending a hostname: it stays suspended through and after any claim, its live claim starts ending at once, and the
/// room holding it is told. Ruled on the review of PR #309: suspension ends the claim, and after a lift the name needs a
/// fresh challenge.
pub fn suspend<'a>(record: &HostnameRecord<'a>) -> (HostnameRecord<'a>, SuspendPlan<'a>) {
    (
        HostnameRecord {
            claim: record.claim,
            ending: record.claim.is_some(),
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
        suspended: false,
        ..*record
    }
}

/// Freeing a claim once [`may_free_claim`] holds: the record keeps its suspension and remembers when, so any later claim
/// needs a challenge made after now.
pub fn free<'a>(record: &HostnameRecord<'a>, now: i64) -> HostnameRecord<'a> {
    HostnameRecord {
        claim: None,
        ending: false,
        suspended: record.suspended,
        last_freed_at: Some(now),
    }
}
