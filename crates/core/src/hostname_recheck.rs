//! The daily recheck of a committed claim's challenge, and how a resolver's answer is read (M6 step 8d; ADR 0010's
//! "Custom domains", step 7; spike D, 2026-11-18). Pure: the room asks the resolver, and this reads what it said.
//!
//! **A resolver's answer is one of three things** ([`read_challenge`]), the same for the proof job's first look (8a),
//! which acts only on a match, and for the recheck:
//!
//! - **a match:** a TXT record the answer shows the challenge's name holding has the request's own value;
//! - **a definite no:** `NXDOMAIN`, or `NOERROR` with no record of the value, every record read. A wildcard in the
//!   customer's zone makes the challenge's name answer `NOERROR` with no TXT (spike D), which is a no: the value isn't
//!   there. A wildcard TXT would answer every name under it with one value, which can't be a request's, since each
//!   request's value is random and made for it alone;
//! - **no answer:** anything else. `SERVFAIL` (a DNSSEC failure among them), any other code, a truncated answer, a
//!   record or a name that can't be read, a TXT owned by a name the answer's CNAME chain doesn't reach, a chain that
//!   loops, forks or runs past [`MAX_CNAME_CHAIN`], and any record type but TXT and CNAME. No answer counts toward
//!   neither no: it never ends a claim quickly, and only a claim with no match for seven days ends on it.
//!
//! **Whose TXT counts:** only one whose owner is the challenge's name or, through the answer's CNAME chain from it, the
//! chain's last name. A name with a CNAME holds nothing else, so a TXT on an earlier link isn't a whole answer either.
//! Spike D saw a TXT asked for one name come back owned by another through a CNAME (`www.github.com`, `github.com`).
//!
//! **Quoting:** Cloudflare's resolver gives a TXT's `data` in quotes, Google's bare (spike D); both are read by
//! `crate::hostnames::txt_rdata_text`, which takes Cloudflare's form exactly and a bare form only as one token with no
//! space, quote or backslash, since bare text with a space can't be told from several strings. A record it can't read
//! never hides a match beside it, and makes an answer with no match no answer, not a no.
//!
//! **DNSSEC's `AD` flag isn't read** (spike D): none of Podster's own zones is signed, and requiring it would refuse
//! every unsigned customer.
use crate::hostnames::{
    proof_matches, txt_rdata_text, RecheckOutcome, NO_PROOF_LIMIT_MS, RECHECK_INTERVAL_MS,
};

/// A TXT record's type number.
pub const TXT: i64 = 16;
/// A CNAME record's type number.
pub const CNAME: i64 = 5;
/// The DNS response code for no error.
pub const NOERROR: i64 = 0;
/// The DNS response code for no such name.
pub const NXDOMAIN: i64 = 3;
/// **Proposed.** The most CNAME links read from the challenge's name; a longer chain is no answer.
pub const MAX_CNAME_CHAIN: usize = 8;

/// One record of a DNS-over-HTTPS JSON answer's `Answer`, as the room read it: its owner `name`, its `type` and its
/// `data`, each exactly as given.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DohRecord<'a> {
    pub name: &'a str,
    pub kind: i64,
    pub data: &'a str,
}

/// A DNS-over-HTTPS JSON answer, as the room read it: `Status`, whether `TC` was true, and `Answer`'s records (none when
/// it was absent). An answer that isn't that shape at all is no answer before it gets here.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DohAnswer<'a> {
    pub status: i64,
    pub truncated: bool,
    pub records: &'a [DohRecord<'a>],
}

/// A name as DNS writes it, for comparing: ASCII lower case, one trailing dot removed, labels of 1 to 63 letters,
/// digits, hyphens and underscores, not beginning or ending with a hyphen, at most 253 characters. `None` for anything
/// else, an escape among them.
pub fn dns_name(name: &str) -> Option<String> {
    let name = name.strip_suffix('.').unwrap_or(name).to_ascii_lowercase();
    let fits = (1..=253).contains(&name.len())
        && name.split('.').all(|label| {
            (1..=63).contains(&label.len())
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
        });
    fits.then_some(name)
}

/// Reads a resolver's answer for `asked`, the challenge's name, against the request's own value: a match, a definite
/// no, or no answer (`ResolverError`), as this module's head says.
pub fn read_challenge(asked: &str, answer: &DohAnswer, expected: &str) -> RecheckOutcome {
    read(asked, answer, expected).unwrap_or(RecheckOutcome::ResolverError)
}

fn read(asked: &str, answer: &DohAnswer, expected: &str) -> Option<RecheckOutcome> {
    if answer.truncated || !matches!(answer.status, NOERROR | NXDOMAIN) {
        return None;
    }
    let records = answer
        .records
        .iter()
        .map(|record| Some((dns_name(record.name)?, record.kind, record.data)))
        .collect::<Option<Vec<_>>>()?;
    // The chain from the challenge's name: each name's one CNAME, followed, never back to a name already on it.
    let mut chain = vec![dns_name(asked)?];
    loop {
        let last = chain.last()?.clone();
        let mut links = records
            .iter()
            .filter(|(owner, kind, _)| *kind == CNAME && *owner == last);
        let Some((_, _, target)) = links.next() else {
            break;
        };
        if links.next().is_some() || chain.len() > MAX_CNAME_CHAIN {
            return None;
        }
        let target = dns_name(target)?;
        if chain.contains(&target) {
            return None;
        }
        chain.push(target);
    }
    let end = chain.last()?;
    let mut values = Vec::new();
    let mut unreadable = false;
    for (owner, kind, data) in &records {
        match *kind {
            CNAME if owner != end && chain.contains(owner) => {}
            TXT if owner == end => match txt_rdata_text(data) {
                Some(text) => values.push(text),
                None => unreadable = true,
            },
            // Another name's record, a TXT on a link before the chain's end, or a type this doesn't read.
            _ => return None,
        }
    }
    if answer.status == NXDOMAIN {
        return (values.is_empty() && !unreadable).then_some(RecheckOutcome::DefiniteNo);
    }
    let values: Vec<&str> = values.iter().map(String::as_str).collect();
    if proof_matches(&values, expected) {
        Some(RecheckOutcome::Match)
    } else if unreadable {
        None
    } else {
        Some(RecheckOutcome::DefiniteNo)
    }
}

/// When a committed claim's next recheck is due: [`RECHECK_INTERVAL_MS`] after its last look (or, before any, after its
/// last proof), and never later than [`NO_PROOF_LIMIT_MS`] after its last proof, so a claim with no match for seven days
/// ends on the day. A look recorded before the last proof counts from the proof.
pub fn next_recheck_at(last_success_at: i64, last_recheck_at: Option<i64>) -> i64 {
    let last_look = last_recheck_at.map_or(last_success_at, |at| at.max(last_success_at));
    last_look
        .saturating_add(RECHECK_INTERVAL_MS)
        .min(last_success_at.saturating_add(NO_PROOF_LIMIT_MS))
}

/// Why the recheck can't look this time, by its code, or `None` when it may: the gate on claims must be open, as for
/// every look the proof job makes, and a resolver configured. A recheck that can't look is recorded as no answer, so it
/// never ends a claim quickly, and a claim nobody can look at ends once seven days pass with no match.
pub fn no_look(claims_open: bool, resolver: bool) -> Option<&'static str> {
    if !claims_open {
        Some("hostname_claims_incomplete")
    } else if !resolver {
        Some("hostname_resolver_missing")
    } else {
        None
    }
}
