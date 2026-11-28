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
//! - **The wire form** ([`token_payload`], [`signing_input`], [`token`], [`enter_location`]): what the API signs and
//!   where it sends the browser (M8 step 7). Signing itself is `podster_egress::preview_key`'s, with the owner's key.
//!
//! **Codes.** Every `code()` here is marked `reasons`: the API answers `preview_access_refused` and
//! `preview_access_limit` by their own literals (M8 step 7), and the content Worker its own (M8 step 8).

use crate::hostnames::normalize;
use crate::preview::{epoch_honoured, MAX_ACCESS_EPOCH};
pub use crate::preview::{is_slot_id, SLOT_ID_PREFIX};
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
/// Tickets one person may be given in one room in [`PER_ROOM_WINDOW_MS`], inside the room's 300 (M8 step 7's review),
/// so no one viewer can spend the room's hour and lock every other viewer out: the 300 then takes at least five people.
/// **Proposed.** A session lasts an hour, so one person on a few devices, sent round again by a few epoch raises, needs
/// a handful; 60 leaves room for that many times over.
pub const PER_PERSON_IN_ROOM_PER_HOUR: usize = 60;

/// Rounds of the flow a navigation may start in [`LOOP_GUARD_WINDOW_MS`] before the gate stops sending it round
/// (spike P1, item 4: "after the second failed round within a minute").
pub const LOOP_GUARD_ROUNDS: u32 = 2;
pub const LOOP_GUARD_WINDOW_MS: i64 = 60 * 1000;

/// The longest return path, as the contract's `PreviewAccessRequest.r` allows.
pub const MAX_RETURN_PATH_LEN: usize = 2048;

/// Before a preview session's ID. **Proposed** here, as [`SLOT_ID_PREFIX`] is.
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
    /// The room's preview slot's ID ([`crate::preview::PreviewSlot::id`]).
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
// The token's wire form (M8 step 7)
// ---------------------------------------------------------------------------------------------------------------------

/// What every token's signature is over, before its payload: a fixed label and version, so a signature made for a
/// preview token is never one for anything else the same key might sign, and a later form can't be read as this one.
pub const TOKEN_SIGNING_PREFIX: &str = "podster-preview-token/v1.";

/// Bytes as base64url with no padding (RFC 4648, section 5).
pub fn base64url(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk.first().copied().unwrap_or(0),
            chunk.get(1).copied().unwrap_or(0),
            chunk.get(2).copied().unwrap_or(0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        let sextets = [(n >> 18) & 63, (n >> 12) & 63, (n >> 6) & 63, n & 63];
        for sextet in sextets.iter().take(chunk.len() + 1) {
            if let Some(c) = BASE64URL.get(*sextet as usize) {
                out.push(char::from(*c));
            }
        }
    }
    out
}

/// Whether a set of claims is fit to sign: every part its form, as [`ticket_claims`], [`session_claims`] and
/// [`marker_claims`] make them, and a lifetime no longer than its type's.
fn claims_formed(claims: &Claims) -> bool {
    let browser_parts = if claims.typ.is_browsers() {
        claims.sid.as_deref().is_some_and(is_session_id)
            && claims.st.as_deref().is_some_and(is_state_hash)
    } else {
        claims.sid.is_none() && claims.st.is_none()
    };
    is_key_id(&claims.kid)
        && is_formed_host(&claims.aud)
        && is_slot_id(&claims.pvw)
        && claims.ep <= MAX_ACCESS_EPOCH
        && claims.exp > claims.iat
        && claims.exp.saturating_sub(claims.iat) <= claims.typ.max_ttl_ms()
        && browser_parts
}

/// **A token's payload**: its claims as one line of JSON, in this fixed order, base64url with no padding. The keys are
/// `typ`, `kid`, `aud`, `pvw`, `sid`, `ep`, `iat`, `exp` and `st`; a marker token has no `sid` or `st`. `ep`, `iat`
/// and `exp` are whole numbers, the two times in milliseconds since the epoch, each exact as a JavaScript number. No
/// value needs escaping, since each is one of its form's characters only. `None` for claims that aren't fit to sign,
/// so nothing malformed is ever signed.
///
/// The whole token is `<payload>.<signature>`: the signature, base64url with no padding, is Ed25519 over the bytes of
/// [`signing_input`]. The content Worker (M8 step 8) reads `kid` from the payload to pick a public key, checks the
/// signature, and only then reads the claims by [`check_claims`]'s rules.
pub fn token_payload(claims: &Claims) -> Option<String> {
    if !claims_formed(claims) {
        return None;
    }
    let mut json = format!(
        r#"{{"typ":"{}","kid":"{}","aud":"{}","pvw":"{}""#,
        claims.typ.name(),
        claims.kid,
        claims.aud,
        claims.pvw
    );
    if let Some(sid) = &claims.sid {
        json.push_str(&format!(r#","sid":"{sid}""#));
    }
    json.push_str(&format!(
        r#","ep":{},"iat":{},"exp":{}"#,
        claims.ep, claims.iat, claims.exp
    ));
    if let Some(st) = &claims.st {
        json.push_str(&format!(r#","st":"{st}""#));
    }
    json.push('}');
    Some(base64url(json.as_bytes()))
}

/// What a token's signature is over: [`TOKEN_SIGNING_PREFIX`] and then the payload, as it is written in the token.
pub fn signing_input(payload: &str) -> String {
    format!("{TOKEN_SIGNING_PREFIX}{payload}")
}

/// The whole token: the payload, a dot, and the signature in base64url with no padding.
pub fn token(payload: &str, signature: &[u8]) -> String {
    format!("{payload}.{}", base64url(signature))
}

/// Whether a byte may stand as it is in [`enter_location`]'s fragment: the URI's unreserved characters only.
fn fragment_safe(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~')
}

/// Percent-encodes every byte that isn't unreserved, so `URLSearchParams` on the fragment gives the value back exactly:
/// `&`, `=`, `#`, `%` and `+` included.
fn fragment_value(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if fragment_safe(byte) {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// **Where the application host sends the browser** (the plan's 5.3, step 4):
/// `https://<host>/__podster/enter#t=<ticket>&s=<session>&r=<r>`. The ticket and the session token are **only after
/// `#`**, which browsers never send to any server, so no access log or `Referer` holds either; nothing is in the path
/// or a query. `r` is percent-encoded, so the fixed exchange page reads all three with `URLSearchParams`. The session
/// travels beside its ticket because the content Worker holds no key and can't sign one (decision 258, the plan's 5.4):
/// it checks both against the browser's state cookie, then sets the session as its cookie, and sets nothing for a
/// ticket that doesn't pass. `None` unless the host is a formed host and `r` a return path ([`return_path_ok`]).
pub fn enter_location(host: &str, ticket: &str, session: &str, r: &str) -> Option<String> {
    let token_safe = |t: &str| !t.is_empty() && t.bytes().all(fragment_safe);
    (is_formed_host(host) && return_path_ok(r) && token_safe(ticket) && token_safe(session)).then(
        || {
            format!(
                "https://{host}{ENTER_PATH}#t={ticket}&s={session}&r={}",
                fragment_value(r)
            )
        },
    )
}

/// The fixed page on every preview host that exchanges a ticket for a session (the plan's 5.3, steps 5 and 6).
pub const ENTER_PATH: &str = "/__podster/enter";

// ---------------------------------------------------------------------------------------------------------------------
// Checking
// ---------------------------------------------------------------------------------------------------------------------

/// The request a token was presented with, as the content Worker sees it after the signature checked out.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Presented<'a> {
    /// The request's host, exactly.
    pub host: &'a str,
    pub now: i64,
    /// The preview slot's ID in the host's serve entry ([`crate::serve_entry::PreviewEntry::slot`]).
    pub entry_slot: &'a str,
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
    /// `pvw` isn't the slot the host's entry names: a token for a slot since deleted, on a host a later slot holds,
    /// whatever either epoch is (M8 step 4's security review).
    WrongSlot,
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
    pub const ALL: [TokenRefusal; 8] = [
        TokenRefusal::WrongType,
        TokenRefusal::WrongAudience,
        TokenRefusal::WrongSlot,
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
/// `pvw` is exactly the slot the host's entry names; `now` is before `exp`; `ep` isn't below the host entry's epoch; for a ticket or a session, `st` is exactly the hash
/// of the state cookie sent with this request; for a marker token, the path is the marker's and the method `GET`.
///
/// **Accepted, not a gap: a ticket replayed in the same browser within its 60 seconds passes again.** Nothing here
/// records a ticket as used, and the contract stores none (`requestPreviewAccess`). Such a replay needs that browser's
/// own state cookie, so it can only give the browser that started the flow the session it was already given, for the
/// same person, slot and epoch; any other browser fails `st`. The 60 seconds and the epoch bound it.
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
    if claims.pvw != presented.entry_slot || !is_slot_id(presented.entry_slot) {
        return Err(TokenRefusal::WrongSlot);
    }
    if presented.now >= claims.exp {
        return Err(TokenRefusal::Expired);
    }
    if !epoch_honoured(claims.ep, presented.entry_epoch) {
        return Err(TokenRefusal::EpochBelow);
    }
    if claims.typ.is_browsers() {
        let bound = match (presented.state_hash, claims.st.as_deref()) {
            (Some(sent), Some(signed)) => constant_time_eq(sent.as_bytes(), signed.as_bytes()),
            _ => false,
        };
        if !bound {
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

/// Whether two byte strings are equal, in time that depends on their lengths only, never on where they first differ:
/// so how long a refusal takes says nothing of how much of a state hash was right (M8 step 8's review).
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |diff, (x, y)| diff | (x ^ y)) == 0
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
    /// One person's tickets in one room, inside the room's hour ([`PER_PERSON_IN_ROOM_PER_HOUR`]).
    PersonInRoom,
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

/// Whether the room may give one person one more ticket this hour, given when it gave them their earlier ones. Counted by
/// the room, from its own session rows, and asked before [`room_access_allowed`], so a person at their own cap never
/// spends the room's.
pub fn person_in_room_allowed(given_at: &[i64], now: i64) -> Result<(), AccessLimit> {
    if in_window(given_at, PER_ROOM_WINDOW_MS, now).len() >= PER_PERSON_IN_ROOM_PER_HOUR {
        Err(AccessLimit::PersonInRoom)
    } else {
        Ok(())
    }
}

/// For a person at their cap in a room, how long until one more ticket fits; `None` if one fits now.
pub fn person_in_room_retry_after_ms(given_at: &[i64], now: i64) -> Option<i64> {
    retry_after(
        given_at,
        PER_PERSON_IN_ROOM_PER_HOUR,
        PER_ROOM_WINDOW_MS,
        now,
    )
}

/// For a person refused, how long until one more ask fits, for `Retry-After`; `None` if one fits now.
pub fn person_retry_after_ms(asked_at: &[i64], now: i64) -> Option<i64> {
    retry_after(asked_at, PER_PERSON_PER_MINUTE, PER_PERSON_WINDOW_MS, now)
}

/// For a room refused, how long until one more ask fits; `None` if one fits now.
pub fn room_retry_after_ms(asked_at: &[i64], now: i64) -> Option<i64> {
    retry_after(asked_at, PER_ROOM_PER_HOUR, PER_ROOM_WINDOW_MS, now)
}
