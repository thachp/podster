//! Access to a preview host: the pure rules (M8 step 4; the preview plan, `docs/m8-preview-plan.md`, sections 5.3 to
//! 5.5 and 5.8, with spike P1's results of 2026-11-28; decisions 252 and 255). Pure, with no I/O, no clock and no
//! keys: every time is passed in, in milliseconds, and signing and verifying signatures are the API's and the content
//! Worker's (M8 steps 7 and 8). Who may view is `podster_policy::preview::may_view`.
//!
//! - **Claims** ([`Claims`], [`ticket_claims`], [`session_claims`], [`marker_claims`]): IDs and hashes only, never a
//!   person ID (the plan's 5.4). A ticket lasts 60 seconds, a session at most an hour, a marker token 60 seconds.
//! - **What a token must pass** ([`check_claims`]): its type, `aud` exactly the host, not expired, a lifetime no longer
//!   than its type's, `ep` not below the host entry's epoch, and for a ticket or session `st` equal to the hash of
//!   this browser's state cookie (the plan's 5.3, steps 6 and 7). The content Worker's copy of this check is
//!   enforcement of what Rust signed, not a decision (the plan's 5.4).
//! - **The two cookies** ([`gate_cookies`]): exact, case-sensitive names; every other name ignored, case variants
//!   included (spike P1, item 1); a second cookie of an exact name refuses.
//! - **Writes** ([`write_allowed`]): `Sec-Fetch-Site: same-origin`, with `Origin` only when that header is absent
//!   (spike P1, item 5).
//! - **The loop guard** ([`next_round`]): no navigation goes round the flow forever (spike P1, item 4).
//! - **The return path** ([`return_path_ok`]) and **the limits on `/v1/preview-access`**: 30 a minute for each person,
//!   300 an hour for each room (the plan's 5.3, step 2), each counted in its own object.
//!
//! **Times.** Every `iat` and `exp` here is in milliseconds since the epoch, as every time in this crate is.
//!
//! **Codes.** Every `code()` here is marked `reasons`: no route answers with one yet (M8 steps 7 and 8 will).

use crate::hostnames::normalize;
use crate::preview::{epoch_honoured, MAX_ACCESS_EPOCH};
use crate::release::window_start;
use crate::release_tree::MARKER_PATH;

/// A ticket's lifetime (the plan's 5.4; decision 257).
pub const TICKET_TTL_MS: i64 = 60 * 1000;
/// A session's longest lifetime (the plan's 5.4; decision 257).
pub const SESSION_MAX_TTL_MS: i64 = 60 * 60 * 1000;
/// A marker token's lifetime (the plan's 3.2, "The marker through a gated host").
pub const MARKER_TTL_MS: i64 = 60 * 1000;

/// The session cookie's name, exactly (the plan's 5.4).
pub const SESSION_COOKIE: &str = "__Host-podster_preview";
/// The state cookie's name, exactly (the plan's 5.3, step 1).
pub const STATE_COOKIE: &str = "__Host-podster_preview_state";
/// The state cookie's `Max-Age`: 12 hours (the plan's 5.3, step 1).
pub const STATE_COOKIE_MAX_AGE_S: i64 = 12 * 60 * 60;
/// The session cookie's `Max-Age`, at most: an hour (the plan's 5.3, step 6).
pub const SESSION_COOKIE_MAX_AGE_S: i64 = SESSION_MAX_TTL_MS / 1000;

/// Asks of `/v1/preview-access` a person may make in [`PER_PERSON_WINDOW_MS`] (the plan's 5.3, step 2).
pub const PER_PERSON_PER_MINUTE: usize = 30;
pub const PER_PERSON_WINDOW_MS: i64 = 60 * 1000;
/// Asks of `/v1/preview-access` a room may be asked in [`PER_ROOM_WINDOW_MS`] (the plan's 5.3, step 2).
pub const PER_ROOM_PER_HOUR: usize = 300;
pub const PER_ROOM_WINDOW_MS: i64 = 60 * 60 * 1000;

/// Rounds of the flow a navigation may start in [`LOOP_GUARD_WINDOW_MS`] before the gate stops sending it round
/// (spike P1, item 4: "after the second failed round within a minute").
pub const LOOP_GUARD_ROUNDS: u32 = 2;
pub const LOOP_GUARD_WINDOW_MS: i64 = 60 * 1000;

/// The longest return path, as the contract's `PreviewAccessRequest.r` allows.
pub const MAX_RETURN_PATH_LEN: usize = 2048;

/// Before a preview slot's ID. **Proposed** here: the plan names `pvw` as the claim but no form for its value.
pub const SLOT_ID_PREFIX: &str = "pvw_";
/// Before a preview session's ID. **Proposed** here, as [`SLOT_ID_PREFIX`].
pub const SESSION_ID_PREFIX: &str = "pvs_";
/// The longest signing key ID. **Proposed.**
pub const MAX_KEY_ID_LEN: usize = 64;

// ---------------------------------------------------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------------------------------------------------

/// What a token is for (the plan's 5.4, `typ`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TokenType {
    /// Delivered in the URL fragment, exchanged once on the preview host, bound to the browser's state.
    Ticket,
    /// The session cookie's value, bound to the same state, checked on every request.
    Session,
    /// The release job's marker fetch through a gated host: that one path, with `GET`.
    Marker,
}

impl TokenType {
    pub const ALL: [TokenType; 3] = [TokenType::Ticket, TokenType::Session, TokenType::Marker];

    pub fn name(self) -> &'static str {
        match self {
            TokenType::Ticket => "ticket",
            TokenType::Session => "session",
            TokenType::Marker => "marker",
        }
    }

    pub fn parse(value: &str) -> Option<TokenType> {
        Self::ALL.into_iter().find(|typ| typ.name() == value)
    }

    /// The longest a token of this type may live, `exp` less `iat`.
    pub fn max_ttl_ms(self) -> i64 {
        match self {
            TokenType::Ticket => TICKET_TTL_MS,
            TokenType::Session => SESSION_MAX_TTL_MS,
            TokenType::Marker => MARKER_TTL_MS,
        }
    }

    /// Whether this type is a browser's, and so carries a session and a state.
    fn is_browsers(self) -> bool {
        matches!(self, TokenType::Ticket | TokenType::Session)
    }
}

fn prefixed_hex_id(text: &str, prefix: &str) -> bool {
    text.strip_prefix(prefix).is_some_and(|hex| {
        hex.len() == 32 && hex.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    })
}

/// A preview slot's ID: `pvw_` and 32 lower-case hexadecimal characters (**Proposed**).
pub fn is_slot_id(text: &str) -> bool {
    prefixed_hex_id(text, SLOT_ID_PREFIX)
}

/// A preview session's ID: `pvs_` and 32 lower-case hexadecimal characters (**Proposed**).
pub fn is_session_id(text: &str) -> bool {
    prefixed_hex_id(text, SESSION_ID_PREFIX)
}

/// A signing key's ID (`kid`): 1 to 64 ASCII letters, digits, `-` and `_` (**Proposed**), so it can name a public key in
/// the content Worker's configuration as it is.
pub fn is_key_id(text: &str) -> bool {
    (1..=MAX_KEY_ID_LEN).contains(&text.len())
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

/// The base64url alphabet, by value.
const BASE64URL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// A state hash (`st`): the SHA-256 of the state cookie, base64url with no padding, **canonical**: 43 characters whose
/// last carries only zero bits past the hash's 256 (the contract's `^[A-Za-z0-9_-]{43}$`, made exact), so one hash has
/// one spelling and two spellings never compare unequal for the same state.
pub fn is_state_hash(text: &str) -> bool {
    let bytes = text.as_bytes();
    let Some((last, rest)) = bytes.split_last() else {
        return false;
    };
    bytes.len() == 43
        && rest.iter().all(|b| BASE64URL.contains(b))
        && BASE64URL
            .iter()
            .position(|b| b == last)
            .is_some_and(|value| value % 4 == 0)
}

/// Whether a host is a formed host name, exactly as it is written: lower case, no trailing dot, no scheme or port, and
/// already in its ASCII form ([`normalize`] leaves it unchanged).
fn is_formed_host(host: &str) -> bool {
    normalize(host).is_ok_and(|formed| formed == host)
}

// ---------------------------------------------------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------------------------------------------------

/// A token's claims (the plan's 5.4): all IDs or hashes, never content, and **no person ID**: the room maps `sid` to
/// the person. Signed by the private API with Ed25519, verified by the content Worker with public keys only.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Claims {
    pub typ: TokenType,
    /// The signing key's ID, for rotation (`PREVIEW_TICKET_KEY` and `_PREVIOUS`, decision 258).
    pub kid: String,
    /// The exact host the token is for.
    pub aud: String,
    /// The preview slot's ID.
    pub pvw: String,
    /// The session's ID: a ticket's and a session's, never a marker's.
    pub sid: Option<String>,
    /// The access epoch when it was signed.
    pub ep: u64,
    pub iat: i64,
    pub exp: i64,
    /// The state hash: a ticket's and a session's, never a marker's.
    pub st: Option<String>,
}

/// What the room signs a ticket and a session from, once it decided access (`podster_policy::preview::decide_access`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TokenAsk<'a> {
    pub kid: &'a str,
    /// The room's current preview host the flow started on, as the room holds it.
    pub host: &'a str,
    pub slot: &'a str,
    pub session: &'a str,
    /// The slot's access epoch now.
    pub epoch: u64,
    /// The `st` the application host passed on from the preview host's redirect.
    pub state_hash: &'a str,
    pub now: i64,
}

/// `preview_claims_invalid`: a part of a token to be signed isn't its form. Nothing is signed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PreviewClaimRefusal;

impl PreviewClaimRefusal {
    // codes: reasons
    pub fn code(self) -> &'static str {
        "preview_claims_invalid"
    }
}

fn base_claims(
    typ: TokenType,
    kid: &str,
    host: &str,
    slot: &str,
    epoch: u64,
    now: i64,
) -> Result<Claims, PreviewClaimRefusal> {
    if !(is_key_id(kid) && is_formed_host(host) && is_slot_id(slot) && epoch <= MAX_ACCESS_EPOCH) {
        return Err(PreviewClaimRefusal);
    }
    Ok(Claims {
        typ,
        kid: kid.to_owned(),
        aud: host.to_owned(),
        pvw: slot.to_owned(),
        sid: None,
        ep: epoch,
        iat: now,
        exp: now.saturating_add(typ.max_ttl_ms()),
        st: None,
    })
}

fn browser_claims(typ: TokenType, ask: &TokenAsk) -> Result<Claims, PreviewClaimRefusal> {
    if !(is_session_id(ask.session) && is_state_hash(ask.state_hash)) {
        return Err(PreviewClaimRefusal);
    }
    let mut claims = base_claims(typ, ask.kid, ask.host, ask.slot, ask.epoch, ask.now)?;
    claims.sid = Some(ask.session.to_owned());
    claims.st = Some(ask.state_hash.to_owned());
    Ok(claims)
}

/// A ticket's claims: bound to the host and the browser's state, for 60 seconds (the plan's 5.3, step 3).
pub fn ticket_claims(ask: &TokenAsk) -> Result<Claims, PreviewClaimRefusal> {
    browser_claims(TokenType::Ticket, ask)
}

/// A session's claims: the same host, session and state as its ticket, for at most an hour (the plan's 5.3, step 6:
/// "whose claims carry the same `st`").
pub fn session_claims(ask: &TokenAsk) -> Result<Claims, PreviewClaimRefusal> {
    browser_claims(TokenType::Session, ask)
}

/// A marker token's claims: bound to the host, for 60 seconds, with no session and no state, since it is the release
/// job's and no browser's (the plan's 3.2). [`check_claims`] accepts it only for the marker's path, with `GET`.
pub fn marker_claims(
    kid: &str,
    host: &str,
    slot: &str,
    epoch: u64,
    now: i64,
) -> Result<Claims, PreviewClaimRefusal> {
    base_claims(TokenType::Marker, kid, host, slot, epoch, now)
}

// ---------------------------------------------------------------------------------------------------------------------
// Checking
// ---------------------------------------------------------------------------------------------------------------------

/// The request a token was presented with, as the content Worker sees it after the signature checked out.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Presented<'a> {
    /// The request's host, exactly.
    pub host: &'a str,
    pub now: i64,
    /// The access epoch in the host's serve entry ([`crate::serve_entry::preview_entry_script`]).
    pub entry_epoch: u64,
    /// The SHA-256 of the state cookie sent with the request, if one was, in [`is_state_hash`]'s form.
    pub state_hash: Option<&'a str>,
    /// The request's path, from its first `/`, with no query.
    pub path: &'a str,
    pub method: &'a str,
}

/// Why a token was refused. Each sends a navigation round the flow again and answers anything else 401 (the plan's
/// 5.3, step 1, and 5.4).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TokenRefusal {
    WrongType,
    /// `aud` isn't exactly this request's host: a token for another preview host, default or custom.
    WrongAudience,
    /// At or past `exp`.
    Expired,
    /// Signed before the room last raised the access epoch (the plan's 5.6).
    EpochBelow,
    /// Its `st` isn't the hash of this browser's state cookie, or no state cookie was sent: a token copied out of
    /// another browser, a log or a crash report (the plan's 5.3, step 7).
    StateMismatch,
    /// A marker token anywhere but the marker's path with `GET`.
    MarkerOnly,
    /// Claims that aren't their form: a lifetime past its type's, `exp` before `iat`, a browser's token without its
    /// session or state, a marker with one.
    Malformed,
}

impl TokenRefusal {
    pub const ALL: [TokenRefusal; 7] = [
        TokenRefusal::WrongType,
        TokenRefusal::WrongAudience,
        TokenRefusal::Expired,
        TokenRefusal::EpochBelow,
        TokenRefusal::StateMismatch,
        TokenRefusal::MarkerOnly,
        TokenRefusal::Malformed,
    ];

    /// The content Worker's answer to a request it refuses on this (the plan's 5.4): an expired session is
    /// `preview_session_expired`, everything else `preview_access_required`.
    // codes: reasons
    pub fn code(self) -> &'static str {
        match self {
            TokenRefusal::Expired => "preview_session_expired",
            _ => "preview_access_required",
        }
    }
}

/// **The checks a token must pass on a preview host** once its signature has (the plan's 5.3, steps 6 and 7, and 5.4),
/// in this order: its claims are their form; its type is the one expected here; `aud` is exactly the request's host;
/// `now` is before `exp`; `ep` isn't below the host entry's epoch; for a ticket or a session, `st` is exactly the hash
/// of the state cookie sent with this request; for a marker token, the path is the marker's and the method `GET`.
pub fn check_claims(
    claims: &Claims,
    expected: TokenType,
    presented: &Presented,
) -> Result<(), TokenRefusal> {
    let lifetime = claims.exp.saturating_sub(claims.iat);
    let carries_browser = claims.sid.is_some() || claims.st.is_some();
    let well_formed = claims.exp > claims.iat
        && lifetime <= claims.typ.max_ttl_ms()
        && claims.ep <= MAX_ACCESS_EPOCH
        && if claims.typ.is_browsers() {
            claims.sid.as_deref().is_some_and(is_session_id)
                && claims.st.as_deref().is_some_and(is_state_hash)
        } else {
            !carries_browser
        };
    if !well_formed {
        return Err(TokenRefusal::Malformed);
    }
    if claims.typ != expected {
        return Err(TokenRefusal::WrongType);
    }
    if claims.aud != presented.host {
        return Err(TokenRefusal::WrongAudience);
    }
    if presented.now >= claims.exp {
        return Err(TokenRefusal::Expired);
    }
    if !epoch_honoured(claims.ep, presented.entry_epoch) {
        return Err(TokenRefusal::EpochBelow);
    }
    if claims.typ.is_browsers() {
        if presented.state_hash.is_none() || presented.state_hash != claims.st.as_deref() {
            return Err(TokenRefusal::StateMismatch);
        }
    } else {
        let marker_path = presented.path.strip_prefix('/') == Some(MARKER_PATH);
        if !(marker_path && presented.method == "GET") {
            return Err(TokenRefusal::MarkerOnly);
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------------------------------
// The two cookies (the plan's 5.4 and 5.5; spike P1, items 1 and 2)
// ---------------------------------------------------------------------------------------------------------------------

/// The values of Podster's two cookies on a preview host, each if sent once.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GateCookies<'a> {
    pub session: Option<&'a str>,
    pub state: Option<&'a str>,
}

/// `preview_access_required`: a second cookie of one of the two exact names. A duplicate of an exact `__Host-` name can
/// only come from the host itself, so the request is refused rather than one picked (the plan's 5.4, kept by spike P1).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DuplicateCookie;

impl DuplicateCookie {
    // codes: reasons
    pub fn code(self) -> &'static str {
        "preview_access_required"
    }
}

/// Podster's two cookies from a request's cookies, as name and value pairs in the order sent. **Only the two exact,
/// case-sensitive names count; every other name is ignored**, a case variant such as `__HOST-podster_preview`
/// included: spike P1 saw WebKit store a sibling's case variant for the whole domain, so refusing one would let a
/// sibling lock every WebKit viewer out of every other preview (spike P1, item 1). A nameless cookie whose value reads
/// `__Host-podster_preview=…` reaches a server as that cookie and can't be told apart from it; all three engines
/// refused to store one from a sibling, so that protection is the browsers', a residual until the production gate
/// (spike P1, item 2; decision 256).
pub fn gate_cookies<'a>(pairs: &[(&'a str, &'a str)]) -> Result<GateCookies<'a>, DuplicateCookie> {
    let mut found = GateCookies {
        session: None,
        state: None,
    };
    for (name, value) in pairs {
        let slot = match *name {
            SESSION_COOKIE => &mut found.session,
            STATE_COOKIE => &mut found.state,
            _ => continue,
        };
        if slot.replace(value).is_some() {
            return Err(DuplicateCookie);
        }
    }
    Ok(found)
}

// ---------------------------------------------------------------------------------------------------------------------
// Writes (the plan's 5.5 and 5.8; spike P1, item 5)
// ---------------------------------------------------------------------------------------------------------------------

/// Whether a request may change state on a preview host, as far as where it came from: `GET`, `HEAD` and `OPTIONS`
/// (an allowed preflight, which the content Worker's request rules still judge) always; anything else only with
/// `Sec-Fetch-Site: same-origin` exactly, so a sibling preview can't drive this preview's writes with its viewer's
/// session, since SameSite can't tell `*.podster.site` hosts apart before the Public Suffix List entry. **The header
/// decides when it is sent** (spike P1, item 5: Firefox and WebKit send `Origin: null` on a page's own write under
/// `Referrer-Policy: no-referrer`); only a request without it falls back to `Origin` being exactly
/// `https://<host>`. Method names are case-sensitive, so `get` is a write.
pub fn write_allowed(
    method: &str,
    sec_fetch_site: Option<&str>,
    origin: Option<&str>,
    host: &str,
) -> bool {
    if matches!(method, "GET" | "HEAD" | "OPTIONS") {
        return true;
    }
    match sec_fetch_site {
        Some(site) => site == "same-origin",
        None => origin.is_some_and(|origin| {
            origin.strip_prefix("https://") == Some(host) && !host.is_empty()
        }),
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// The loop guard (spike P1, item 4)
// ---------------------------------------------------------------------------------------------------------------------

/// The rounds of the flow a browser has started, which the state cookie carries (its value is Podster's own).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FlowRounds {
    pub count: u32,
    pub first_at: i64,
}

/// What the gate does with a navigation that has no valid session.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LoopDecision {
    /// Send it round the flow, recording this round.
    Round(FlowRounds),
    /// `preview_access_required` (401) with a fixed page: it has gone round twice in a minute and still has no session,
    /// whether from eviction pressure, a stuck cookie or a browser's oddity.
    Stop,
}

impl LoopDecision {
    // codes: reasons
    pub fn code(self) -> &'static str {
        match self {
            LoopDecision::Round(_) => "preview_round",
            LoopDecision::Stop => "preview_access_required",
        }
    }
}

/// The next round, given the rounds recorded so far (`None` for a browser that hasn't started one): after the second
/// round within a minute of the first, stop. A minute after the first, the count starts again. A first round stamped
/// in the future, a clock step back, still counts as within the minute. A successful exchange clears the record.
pub fn next_round(previous: Option<FlowRounds>, now: i64) -> LoopDecision {
    match previous {
        Some(rounds) if now.saturating_sub(rounds.first_at) < LOOP_GUARD_WINDOW_MS => {
            if rounds.count >= LOOP_GUARD_ROUNDS {
                LoopDecision::Stop
            } else {
                LoopDecision::Round(FlowRounds {
                    count: rounds.count.saturating_add(1),
                    first_at: rounds.first_at,
                })
            }
        }
        _ => LoopDecision::Round(FlowRounds {
            count: 1,
            first_at: now,
        }),
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// The return path (the plan's 5.3, steps 1 and 6; the contract's `PreviewAccessRequest.r`)
// ---------------------------------------------------------------------------------------------------------------------

/// Whether `r` is a path and query on the same host to come back to: it begins with exactly one `/` (not `//` or
/// `/\`, which a browser reads as another host), is at most 2,048 bytes, and holds only visible ASCII, so no space,
/// control character or line break.
pub fn return_path_ok(r: &str) -> bool {
    let bytes = r.as_bytes();
    (1..=MAX_RETURN_PATH_LEN).contains(&bytes.len())
        && bytes.first() == Some(&b'/')
        && !matches!(bytes.get(1), Some(b'/' | b'\\'))
        && bytes.iter().all(|b| b.is_ascii_graphic())
}

// ---------------------------------------------------------------------------------------------------------------------
// The limits on `/v1/preview-access` (the plan's 5.3, step 2)
// ---------------------------------------------------------------------------------------------------------------------

/// `preview_access_limit` (429): a person past 30 asks a minute, counted in their own `Principal`, or a room past 300
/// an hour, counted in its own Workspace, so neither needs a read model.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AccessLimit {
    Person,
    Room,
}

impl AccessLimit {
    // codes: reasons
    pub fn code(self) -> &'static str {
        "preview_access_limit"
    }
}

/// The stamps still inside a rolling window at `now`: every stamp at or after [`window_start`], one in the future
/// included, so a clock step backwards can't free the window.
fn in_window(asked_at: &[i64], window_ms: i64, now: i64) -> Vec<i64> {
    let start = window_start(now, window_ms);
    let mut kept: Vec<i64> = asked_at.iter().copied().filter(|at| *at >= start).collect();
    kept.sort_unstable();
    kept
}

/// How long until one more ask fits, or `None` if one fits now: the moment enough of the oldest stamps have left.
fn retry_after(asked_at: &[i64], most: usize, window_ms: i64, now: i64) -> Option<i64> {
    let kept = in_window(asked_at, window_ms, now);
    let over = kept.len().checked_sub(most)?;
    // The (over + 1)th oldest must leave: it leaves at its stamp plus the window.
    let leaves = kept.get(over)?.saturating_add(window_ms);
    Some(leaves.saturating_sub(now).max(1))
}

/// Whether a person may ask once more, given when their earlier asks were.
pub fn person_access_allowed(asked_at: &[i64], now: i64) -> Result<(), AccessLimit> {
    if in_window(asked_at, PER_PERSON_WINDOW_MS, now).len() >= PER_PERSON_PER_MINUTE {
        Err(AccessLimit::Person)
    } else {
        Ok(())
    }
}

/// Whether a room may be asked once more, given when its earlier asks were.
pub fn room_access_allowed(asked_at: &[i64], now: i64) -> Result<(), AccessLimit> {
    if in_window(asked_at, PER_ROOM_WINDOW_MS, now).len() >= PER_ROOM_PER_HOUR {
        Err(AccessLimit::Room)
    } else {
        Ok(())
    }
}

/// For a person refused, how long until one more ask fits, for `Retry-After`; `None` if one fits now.
pub fn person_retry_after_ms(asked_at: &[i64], now: i64) -> Option<i64> {
    retry_after(asked_at, PER_PERSON_PER_MINUTE, PER_PERSON_WINDOW_MS, now)
}

/// For a room refused, how long until one more ask fits; `None` if one fits now.
pub fn room_retry_after_ms(asked_at: &[i64], now: i64) -> Option<i64> {
    retry_after(asked_at, PER_ROOM_PER_HOUR, PER_ROOM_WINDOW_MS, now)
}
