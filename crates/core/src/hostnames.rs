//! A custom hostname for a room's app: the name's normalization and refusals, the room-bound challenge, the one claim
//! per hostname, its recheck, and suspension (ADR 0010, custom domains; decisions 201 and 207). Pure, with no I/O and
//! no clock: every time is passed in, in milliseconds.
//!
//! Podster's own proof comes before any claim and before Cloudflare is asked. Cloudflare's validation alone isn't proof.

use std::net::{IpAddr, Ipv4Addr};

use icu_properties::props::DefaultIgnorableCodePoint;
use icu_properties::CodePointSetData;

/// Whether text holds a code point IDNA drops without a trace (Unicode's Default_Ignorable_Code_Point: U+00AD, U+034F,
/// U+180E, U+200B to U+200F, U+2060, U+FE00 to U+FE0F, U+FEFF and the rest). Such a name or rule is refused before
/// mapping, so it can't read as another. Added after the second review of PR #311.
fn has_ignorable(text: &str) -> bool {
    let ignorable = CodePointSetData::new::<DefaultIgnorableCodePoint>();
    text.chars().any(|c| ignorable.contains(c))
}

/// The longest hostname, in its ASCII form.
pub const MAX_HOSTNAME_LEN: usize = 253;
/// The longest label of a hostname.
pub const MAX_HOSTNAME_LABEL_LEN: usize = 63;
/// Podster's own domain. Neither it nor anything under it may be mapped.
pub const PODSTER_DOMAIN: &str = "podster.dev";
/// Every domain of Podster's that no room may map, nor any name under one: its own, the content domain first named
/// (`opster.dev`, replaced the same day and still Podster's), and the content domain named since (`podster.site`). A
/// deployment's configured content domain is refused as well, whatever it is.
pub const RESERVED_DOMAINS: [&str; 3] = [PODSTER_DOMAIN, "opster.dev", "podster.site"];
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
    /// `hostname_reserved`: one of [`RESERVED_DOMAINS`], the content domain, or a name under one.
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
    if input.is_empty()
        || input.chars().any(|c| c.is_whitespace() || c.is_control())
        || has_ignorable(input)
    {
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

/// Whether a content domain is Podster's own (the security review of PR #563, 2026-11-23): `podster.dev` or a name
/// under it, or the registrable domain of one of `own_addresses`, the application's and the gateway's addresses as the
/// Worker's configuration gives them, or a name under that. A content domain serves agents' apps, so one that is
/// Podster's would serve them beside Podster's own pages and cookies. With no Public Suffix List here, a registrable
/// domain is read as the host's last two labels, which errs strict: under a two-label suffix such as `co.uk` it
/// refuses more than it must, never less. An address that isn't an `http` or `https` URL on a host is skipped.
pub fn content_domain_is_podsters(domain: &str, own_addresses: &[&str]) -> bool {
    let domain = domain.to_ascii_lowercase();
    let mut roots = vec![PODSTER_DOMAIN.to_string()];
    for address in own_addresses {
        let Some(host) = reported_host(address) else {
            continue;
        };
        let mut last_two: Vec<&str> = host.rsplit('.').take(2).collect();
        last_two.reverse();
        roots.push(last_two.join("."));
    }
    roots
        .iter()
        .any(|root| domain == *root || domain.ends_with(&format!(".{root}")))
}

/// The longest address a report may give, in characters (Unicode scalar values), as the contract's `maxLength` counts
/// them: an address with multi-byte characters may be longer in bytes.
pub const MAX_REPORTED_ADDRESS_LEN: usize = 2048;

/// The host a report names (M6 step 9): the address as a reporter saw it, either a hostname or an `http` or `https` URL
/// on one. Only the host is kept, normalized as [`normalize`] does, so two spellings of a host are one. The URL's path,
/// query, fragment and port are dropped; one with a user name or password is refused, since it can show one host and
/// mean another. Whether anything is served at the host isn't asked: a report answers the same either way.
pub fn reported_host(address: &str) -> Option<String> {
    if address.is_empty() || address.chars().count() > MAX_REPORTED_ADDRESS_LEN {
        return None;
    }
    let lower = address.to_ascii_lowercase();
    let rest = ["https://", "http://"]
        .iter()
        .find_map(|scheme| lower.starts_with(scheme).then(|| &address[scheme.len()..]));
    let host = match rest {
        Some(rest) => {
            let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
            if authority.contains(['@', '[', ']', '\\']) {
                return None;
            }
            match authority.rsplit_once(':') {
                Some((name, port))
                    if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) =>
                {
                    name
                }
                Some(_) => return None,
                None => authority,
            }
        }
        None if address.contains("://") => return None,
        None => address,
    };
    normalize(host).ok()
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

/// The rules in the Public Suffix List's own text, line by line, as its format defines: a blank line and a line
/// beginning `//` are skipped, and a rule is read up to the first whitespace. Pass what this returns to [`mappable`]: a
/// comment or blank line passed to it as a rule fails closed, like anything else it can't read.
pub fn public_suffix_rules(list: &str) -> Vec<&str> {
    // A byte-order mark at the start is a common form of the file, not part of its first line.
    let list = list.strip_prefix('\u{FEFF}').unwrap_or(list);
    list.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with("//"))
        .filter_map(|line| line.split_whitespace().next())
        .collect()
}

/// The line that opens the list's ICANN section, as the list writes it.
pub const ICANN_BEGIN: &str = "// ===BEGIN ICANN DOMAINS===";
/// The line that closes the list's ICANN section.
pub const ICANN_END: &str = "// ===END ICANN DOMAINS===";

/// The rules of the Public Suffix List's ICANN section only, read as [`public_suffix_rules`] reads them (docs/m6-plan.md,
/// 8a's open question 1: the snapshot the API is built with). The private section, names such as `github.io` that their
/// owners listed themselves, is left out: a claim still needs the challenge published in the name's own DNS, which only
/// whoever runs that zone can do. Empty, which [`mappable`] refuses as `hostname_unavailable`, unless the text has
/// exactly one opening line and one closing line after it, each alone on its line.
pub fn icann_public_suffix_rules(list: &str) -> Vec<&str> {
    let list = list.strip_prefix('\u{FEFF}').unwrap_or(list);
    let lines: Vec<&str> = list.lines().map(str::trim).collect();
    let at = |marker: &str| -> Option<usize> {
        let mut found = lines.iter().enumerate().filter(|(_, l)| **l == marker);
        let first = found.next()?.0;
        found.next().is_none().then_some(first)
    };
    let (Some(begin), Some(end)) = (at(ICANN_BEGIN), at(ICANN_END)) else {
        return Vec::new();
    };
    let Some(section) = lines.get(begin + 1..end) else {
        return Vec::new();
    };
    section
        .iter()
        .filter(|line| !line.is_empty() && !line.starts_with("//"))
        .filter_map(|line| line.split_whitespace().next())
        .collect()
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
        // Each label as a hostname's: 1 to 63 letters, digits and hyphens after IDNA. A comment, a blank, or any other
        // text isn't a rule, and fails closed.
        // Nothing IDNA would quietly map away or drop: no whitespace, no control or format character, and no ASCII but
        // letters, digits, hyphens and dots.
        if body.is_empty()
            || has_ignorable(body)
            || body.chars().any(|c| {
                c.is_whitespace()
                    || c.is_control()
                    || c == '\u{FEFF}'
                    || c == '\u{AD}'
                    || ('\u{200B}'..='\u{200F}').contains(&c)
                    || (c.is_ascii() && !(c.is_ascii_alphanumeric() || c == '-' || c == '.'))
            })
        {
            return None;
        }
        let ascii = idna::domain_to_ascii(body).ok()?;
        let ok = ascii.split('.').all(|l| {
            (1..=MAX_HOSTNAME_LABEL_LEN).contains(&l.len())
                && l.bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        });
        ok.then(|| ascii.split('.').map(str::to_owned).collect())
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
    if RESERVED_DOMAINS
        .iter()
        .any(|domain| is_or_under(&name, domain))
        || is_or_under(&name, &content)
    {
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

/// Whether the room may end a request as expired by its own clock (M6 step 8): it is pending, past its 72 hours, and
/// its proof was never taken to the hostname's object. Once it was (`proof_asked`), the object may already have given
/// the claim, so only the object's answer ends it ([`decide_claim`] answers `Expired` for a claim it never gave).
pub fn request_expired(
    state: crate::hostname_requests::HostnameRequestState,
    proof_asked: bool,
    requested_at: i64,
    now: i64,
) -> bool {
    state == crate::hostname_requests::HostnameRequestState::Pending
        && !proof_asked
        && pending_expired(requested_at, now)
}

/// **Proposed.** How often a pending request's challenge is looked for in its first hour.
pub const PROOF_EARLY_INTERVAL_MS: i64 = 60 * 1000;
/// **Proposed.** How often after that, until it expires.
pub const PROOF_LATE_INTERVAL_MS: i64 = 15 * 60 * 1000;
/// **Proposed.** How long the first, frequent looks go on.
pub const PROOF_EARLY_SPAN_MS: i64 = 60 * 60 * 1000;

/// When a pending request's challenge is next looked for: at once if it never was, then a minute after each look for
/// its first hour, and fifteen minutes after each look from then on. Taken from the last look, so a clock that ran
/// backwards never makes a look due before the one it follows.
pub fn next_proof_check(requested_at: i64, checked_at: Option<i64>) -> i64 {
    let Some(checked_at) = checked_at else {
        return requested_at;
    };
    let interval = if checked_at.saturating_sub(requested_at) < PROOF_EARLY_SPAN_MS {
        PROOF_EARLY_INTERVAL_MS
    } else {
        PROOF_LATE_INTERVAL_MS
    };
    checked_at.saturating_add(interval)
}

/// One TXT record's text, from the presentation form a DNS-over-HTTPS JSON answer gives in `data`: one or more quoted
/// strings, separated by spaces, joined into one value, with `\"`, `\\` and `\DDD` undone. A resolver that gives the
/// text bare is read as one token, taken as it is. `None` for anything else, a value that unescapes to a byte that
/// isn't text among them: a record that can't be read proves nothing.
pub fn txt_rdata_text(data: &str) -> Option<String> {
    if data.is_empty() {
        return None;
    }
    if !data.starts_with('"') {
        let bare = data
            .chars()
            .all(|c| c.is_ascii_graphic() && c != '"' && c != '\\');
        return bare.then(|| data.to_owned());
    }
    let bytes = data.as_bytes();
    let mut out: Vec<u8> = Vec::new();
    let mut at = 0;
    loop {
        // At a string's opening quote.
        if bytes.get(at) != Some(&b'"') {
            return None;
        }
        at += 1;
        loop {
            let byte = *bytes.get(at)?;
            match byte {
                b'"' => {
                    at += 1;
                    break;
                }
                b'\\' => {
                    let next = *bytes.get(at + 1)?;
                    if next.is_ascii_digit() {
                        let digits = bytes.get(at + 1..at + 4)?;
                        if !digits.iter().all(u8::is_ascii_digit) {
                            return None;
                        }
                        let value = digits
                            .iter()
                            .fold(0u32, |n, d| n * 10 + u32::from(d - b'0'));
                        out.push(u8::try_from(value).ok()?);
                        at += 4;
                    } else {
                        out.push(next);
                        at += 2;
                    }
                }
                byte if byte.is_ascii_control() => return None,
                byte => {
                    out.push(byte);
                    at += 1;
                }
            }
        }
        if at == bytes.len() {
            break;
        }
        // Strings are separated by spaces, and nothing else.
        let spaces = bytes
            .get(at..)
            .unwrap_or_default()
            .iter()
            .take_while(|b| **b == b' ')
            .count();
        if spaces == 0 || at + spaces == bytes.len() {
            return None;
        }
        at += spaces;
    }
    let text = String::from_utf8(out).ok()?;
    (!text.chars().any(char::is_control)).then_some(text)
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
    /// When the name was last suspended. Every request and challenge made at or before it is void: after a lift, a
    /// fresh request is needed.
    pub last_suspended_at: Option<i64>,
    /// When the name's suspension was last lifted. Kept for the record; decisions use `generation`.
    pub last_lifted_at: Option<i64>,
    /// Advanced by every suspend, lift and free. A request is honoured only under the generation it was made under, so
    /// no clock decides whether a suspension, a lift or a freed claim came before it. Added after the second review of
    /// PR #311.
    pub generation: u64,
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
    /// The name's `generation` when the request was made, read from its record. Added after the second review of PR
    /// #311.
    pub generation: u64,
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
    /// `hostname_request_withdrawn`: the room withdrew this request before it ever committed a claim for it, so it is
    /// never granted, whichever of the two reached the object first ([`decide_ask`], [`withdraw`]).
    Withdrawn,
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
            ClaimDecision::Withdrawn => "hostname_request_withdrawn",
        }
    }

    pub const ALL: [ClaimDecision; 8] = [
        ClaimDecision::Granted,
        ClaimDecision::HeldElsewhere,
        ClaimDecision::Suspended,
        ClaimDecision::Unproven,
        ClaimDecision::StaleChallenge,
        ClaimDecision::Expired,
        ClaimDecision::Ending,
        ClaimDecision::Withdrawn,
    ];

    /// The decision a code names, as the hostname's object answers it to a room. `None` for anything else.
    pub fn from_code(code: &str) -> Option<ClaimDecision> {
        Self::ALL
            .into_iter()
            .find(|decision| decision.code() == code)
    }
}

/// The hostname object's decision on a room's ask, given whether the room has withdrawn that request (M6 step 8). A
/// withdrawn request is refused whatever the record says, so a withdrawal that reached the object before the ask it
/// overtook still wins. Otherwise it is [`decide_claim`].
pub fn decide_ask(
    record: &HostnameRecord,
    ask: &ClaimAsk,
    withdrawn: bool,
    now: i64,
) -> ClaimDecision {
    if withdrawn {
        return ClaimDecision::Withdrawn;
    }
    decide_claim(record, ask, now)
}

/// What a room's withdrawal did in the hostname's object.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Withdrawal {
    /// The object held a claim, live or ending, for exactly that room and request, and freed it.
    Freed,
    /// The object held no claim: the withdrawal is recorded, and that request is never granted.
    NothingHeld,
    /// Another room, or another request of this room, holds the name: nothing of it changes.
    HeldByOther,
}

/// A room withdraws a request it never committed as claimed (M6 step 8): it removed a request whose proof it had taken
/// to the object, or a suspension's notice ended it, before the room recorded a claim. **The room's word that it never
/// committed the claim is what makes freeing safe:** nothing served on the name, and no custom hostname was made at
/// Cloudflare, which is only ever made for a claim the room committed. So [`may_free_claim`] holds, and the claim is
/// freed at once, live or ending; the generation advances, as every free does. A claim anyone else holds is untouched.
pub fn withdraw<'a>(
    record: &HostnameRecord<'a>,
    room: &str,
    request: &str,
    now: i64,
) -> (HostnameRecord<'a>, Withdrawal) {
    match record.claim {
        Some(claim) if claim.room == room && claim.request == request => {
            (free(record, now), Withdrawal::Freed)
        }
        Some(_) => (*record, Withdrawal::HeldByOther),
        None => (*record, Withdrawal::NothingHeld),
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
        || ask.generation != record.generation
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

/// What a room's word that its committed claim is ending did in the hostname's object (M6 step 8b).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EndBegun {
    /// The object holds exactly that room's and request's claim, and it is ending now, or was already.
    Ending,
    /// The object holds no claim for that room and request: none at all, or someone else's. Nothing changes.
    NotHeld,
}

/// A room says its committed claim is ending (M6 step 8b): the object marks it so, and from then it serves nothing and is
/// never granted again ([`decide_claim`] answers `Ending`), while it still holds the name. Only exactly that room's and
/// request's claim is touched. The generation doesn't move: only freeing moves it.
pub fn begin_end<'a>(
    record: &HostnameRecord<'a>,
    room: &str,
    request: &str,
) -> (HostnameRecord<'a>, EndBegun) {
    match record.claim {
        Some(claim) if claim.room == room && claim.request == request => {
            (end_claim(record), EndBegun::Ending)
        }
        _ => (*record, EndBegun::NotHeld),
    }
}

/// What a room's word that its ending claim's custom hostname is gone did in the hostname's object (M6 step 8b).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FreeOutcome {
    /// The object held exactly that room's and request's claim, ending, and freed it.
    Freed,
    /// It holds that claim, still live: the room must have it marked ending first, and nothing is freed.
    NotEnding,
    /// It holds no claim for that room and request: freed already, or someone else's. Nothing changes.
    NotHeld,
}

/// A room frees its ending claim, once it has cleared the host and Cloudflare read the custom hostname gone
/// ([`may_free_claim`], which the room decides, since both facts are the room's). Only exactly that room's and request's
/// claim, and only once it is ending. Freeing advances the generation and keeps any suspension ([`free`]).
pub fn free_ended<'a>(
    record: &HostnameRecord<'a>,
    room: &str,
    request: &str,
    now: i64,
) -> (HostnameRecord<'a>, FreeOutcome) {
    match record.claim {
        Some(claim) if claim.room == room && claim.request == request => {
            if record.ending {
                (free(record, now), FreeOutcome::Freed)
            } else {
                (*record, FreeOutcome::NotEnding)
            }
        }
        _ => (*record, FreeOutcome::NotHeld),
    }
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
    /// The value isn't there: through a recursive resolver, `NXDOMAIN`, or `NOERROR` with every record read and none
    /// the value (M6 step 8d, spike D; `crate::hostname_recheck::read_challenge`).
    DefiniteNo,
    /// No answer: the resolver failed, timed out, or gave anything else (`SERVFAIL`, a truncated or malformed answer, a
    /// record that can't be read). It counts toward neither no.
    ResolverError,
}

/// A live claim's proof history.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProofHistory {
    /// The last time the proof matched: the proof that won the claim, then each matching recheck.
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
    /// `hostname_gone_at_provider`: Cloudflare read the custom hostname gone after the room had recorded it made (M6
    /// step 8b). Something outside Podster deleted it, or Cloudflare did after it was `moved` for seven days.
    GoneAtProvider,
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
            ClaimEnd::GoneAtProvider => "hostname_gone_at_provider",
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

/// Whether the host may start serving: the hostname's own record shows `room` holding a live claim on a name that isn't
/// suspended (as [`custom_host_may_serve`] reads it), and Cloudflare reports the hostname `active`. It takes the record,
/// not a flag, so no caller can reopen an ending or suspended host from `claim.room` alone.
pub fn routing_may_start(record: &HostnameRecord, room: &str, cloudflare_status: &str) -> bool {
    custom_host_may_serve(true, record, room) && cloudflare_status == "active"
}

/// Between a custom hostname's script and its host in its serve entry (M6 step 8c). Neither a script's name nor a host
/// can hold it.
pub const CUSTOM_ENTRY_SEPARATOR: char = '@';

/// A custom hostname's serve entry (M6 step 8c): the script's name, [`CUSTOM_ENTRY_SEPARATOR`], then the host it is
/// written under. A default host's entry is the script's name alone, so the two forms can't be taken for each other,
/// and a custom host's value names the one host it may serve. `None` unless the script is a name Podster makes and the
/// host is written exactly as Podster writes names.
pub fn custom_entry_value(host: &str, script: &str) -> Option<String> {
    let made = matches!(
        crate::release::script_owner(script),
        crate::release::ScriptOwner::Podster { .. }
    );
    // More than one label, as a room's request stores a name (a single label is never mappable).
    (made && host.contains('.') && normalize(host).ok().as_deref() == Some(host))
        .then(|| format!("{script}{CUSTOM_ENTRY_SEPARATOR}{host}"))
}

/// The script a custom hostname's entry names, read for exactly `host`: `None` for any value [`custom_entry_value`]
/// wouldn't write for that host and script. The content Worker holds a copy of this rule, tested against the same
/// vectors (`packages/contracts/serve-entry.fixture.json`).
pub fn custom_entry_script<'a>(host: &str, value: &'a str) -> Option<&'a str> {
    // Exactly what would be written for this host and the script before the separator: so the host after it is this
    // one, and nothing else is in the value.
    let (script, _) = value.split_once(CUSTOM_ENTRY_SEPARATOR)?;
    (custom_entry_value(host, script).as_deref() == Some(value)).then_some(script)
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

/// Suspending a hostname at `now`: it stays suspended through and after any claim, its live claim starts ending at once,
/// the room holding it is told, and every pending request and challenge for the name is void: the generation advances. Ruled on
/// the reviews of PR #309: suspension ends the claim, and after a lift the name needs a fresh request.
pub fn suspend<'a>(record: &HostnameRecord<'a>, now: i64) -> (HostnameRecord<'a>, SuspendPlan<'a>) {
    (
        HostnameRecord {
            claim: record.claim,
            ending: record.claim.is_some(),
            suspended: true,
            last_freed_at: record.last_freed_at,
            // Kept for the record, only ever forward; the generation is what decides.
            last_suspended_at: Some(record.last_suspended_at.map_or(now, |at| at.max(now))),
            last_lifted_at: record.last_lifted_at,
            generation: record.generation.saturating_add(1),
        },
        SuspendPlan {
            tell_room: record.claim.map(|c| c.room),
        },
    )
}

/// Lifting a suspension at `now` restores nothing: no claim comes back, and only a request made after the lift counts,
/// decided by the record's own `generation`, which the lift advances, not by any clock. While suspended, every request is refused
/// `Suspended` and nothing is recorded as pending; the caller records nothing for a refused request.
pub fn lift<'a>(record: &HostnameRecord<'a>, now: i64) -> HostnameRecord<'a> {
    HostnameRecord {
        suspended: false,
        last_lifted_at: Some(record.last_lifted_at.map_or(now, |at| at.max(now))),
        generation: record.generation.saturating_add(1),
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
        last_suspended_at: record.last_suspended_at,
        last_lifted_at: record.last_lifted_at,
        generation: record.generation.saturating_add(1),
    }
}
