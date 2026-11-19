//! The inbound nudge, server side: M7 step 13. No I/O.
//!
//! Design: [M7 plan](../../../docs/m7-plan.md) step 13, [decision 236](../../../docs/spec/PRODUCT.md#decisions-needed) and
//! RUNNER.md's "Optional inbound A2A". Everything here is **Proposed**.
//!
//! An agent's A2A endpoint has a delivery mode. `offers`, the default, is ADR 0007's: each offer goes out with its text.
//! `nudge` sends IDs only: a signed `SendMessage` naming the room, the task and the offer attempt, so the agent fetches
//! the task over its own outbound connection. A nudge endpoint sends nothing until both of these hold for its current
//! registration version:
//!
//! - **Control.** Podster sends the endpoint a signed challenge and it answers with [`proof`]: an HMAC under the
//!   registration's signing secret, which only the registrant was shown. An echo of the request, or an answer from
//!   anyone else's server, can't make it.
//! - **The owner's opt-in.** A person who administers the agent's organization switches the nudge on for that exact
//!   version, after it's verified. The agent can't switch it on for itself.
//!
//! Any set that makes a new signing secret (a new URL, a new delivery mode, or a rotation) clears both, and so does a
//! delete or a disconnect. Failed nudges count toward switching the endpoint off as offers do, and are retried with
//! [`retry_delay_secs`]. The inbox stays the source of truth, so a missed nudge loses nothing.

use crate::endpoint::{decide_set, SetOutcome, TokenChange};
use hmac::{Hmac, Mac};
use sha2::Sha256;

/// How an endpoint is sent to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Delivery {
    /// ADR 0007's outbound offers, with the task's text.
    Offers,
    /// IDs only, after proof of control and the owner's opt-in.
    Nudge,
}

impl Delivery {
    pub fn name(self) -> &'static str {
        match self {
            Delivery::Offers => "offers",
            Delivery::Nudge => "nudge",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        match name {
            "offers" => Some(Delivery::Offers),
            "nudge" => Some(Delivery::Nudge),
            _ => None,
        }
    }
}

/// What the proof is an HMAC of, before the agent, version and challenge, so it can't be confused with a request signature.
pub const PROOF_LABEL: &str = "podster-endpoint-proof/1";
/// The JSON-RPC method of the challenge. It isn't an A2A method: only an endpoint that's set up as a nudge answers it.
pub const CHALLENGE_METHOD: &str = "podster.dev/verifyEndpoint";
/// **Proposed:** challenges sent for one signing secret before verifying refuses until a new one is made.
pub const MAX_VERIFY_ATTEMPTS: i64 = 5;
/// **Proposed:** challenges sent for one agent within [`VERIFY_WINDOW_MS`], whatever its endpoint or secret. Neither a
/// rotation, a new URL nor a delete starts it over, so a new secret can't buy more requests.
pub const MAX_VERIFY_PER_WINDOW: i64 = 10;
/// The window [`MAX_VERIFY_PER_WINDOW`] counts over: an hour.
pub const VERIFY_WINDOW_MS: i64 = 60 * 60 * 1000;
/// **Proposed:** the largest answer to a challenge that's read. A proof is 64 characters.
pub const MAX_PROOF_ANSWER_BYTES: usize = 4 * 1024;
/// **Proposed:** the first retry of a failed nudge, doubling each time to [`RETRY_MAX_SECS`].
pub const RETRY_BASE_SECS: u32 = 60;
/// **Proposed:** the longest wait between retries of one nudge.
pub const RETRY_MAX_SECS: u32 = 15 * 60;
/// A challenge is this many lowercase hex characters: 256 bits.
pub const CHALLENGE_HEX: usize = 64;

fn mac(secret: &str, agent: &str, version: u64, challenge: &str) -> Hmac<Sha256> {
    #[allow(clippy::expect_used)]
    // HMAC accepts a key of any length, so this can't fail, and there's no error to return.
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("any key length");
    mac.update(format!("{PROOF_LABEL}.{agent}.{version}.{challenge}").as_bytes());
    mac
}

/// The answer an endpoint gives to prove it holds the registration's signing secret: lowercase hex HMAC-SHA256 under that
/// secret over `podster-endpoint-proof/1.{agent}.{version}.{challenge}`.
pub fn proof(secret: &str, agent: &str, version: u64, challenge: &str) -> String {
    mac(secret, agent, version, challenge)
        .finalize()
        .into_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Whether `given` is the proof, compared in constant time. Anything that isn't 64 lowercase hex characters isn't.
pub fn proof_matches(
    secret: &str,
    agent: &str,
    version: u64,
    challenge: &str,
    given: &str,
) -> bool {
    if given.len() != 64
        || !given
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return false;
    }
    let bytes: Option<Vec<u8>> = (0..given.len())
        .step_by(2)
        .map(|at| {
            given
                .get(at..at + 2)
                .and_then(|pair| u8::from_str_radix(pair, 16).ok())
        })
        .collect();
    bytes.is_some_and(|bytes| {
        mac(secret, agent, version, challenge)
            .verify_slice(&bytes)
            .is_ok()
    })
}

/// Whether a stored challenge has the shape this makes.
pub fn valid_challenge(challenge: &str) -> bool {
    challenge.len() == CHALLENGE_HEX
        && challenge
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// The mode a set asks for. Left out, it keeps the mode of the registration in force, so a set that only changes a token
/// or a URL doesn't drop a nudge endpoint to offers; with none in force it's `offers`, as every endpoint was before M7
/// step 13.
pub fn delivery_for_set(asked: Option<Delivery>, current: Option<Delivery>) -> Delivery {
    asked.or(current).unwrap_or(Delivery::Offers)
}

/// [`decide_set`] with the delivery mode: changing the mode is a new registration, as changing the URL is, so attempts and
/// read-backs pinned to the old one end, and the new one needs its own proof and opt-in.
pub fn decide_set_for(
    current_url: Option<&str>,
    current_delivery: Delivery,
    highest_version: u64,
    url: &str,
    delivery: Delivery,
    token: TokenChange,
    rotate_secret: bool,
) -> SetOutcome {
    let same_mode = current_url.filter(|_| current_delivery == delivery);
    decide_set(same_mode, highest_version, url, token, rotate_secret)
}

/// Where a nudge endpoint stands now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NudgeState {
    pub version: u64,
    /// Whether its control was proved for the current signing secret.
    pub verified: bool,
    /// The version the owner switched the nudge on for, if they did and it wasn't cleared.
    pub opted_in_version: Option<u64>,
}

/// Why a nudge endpoint sends nothing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NudgeHold {
    Unverified,
    Off,
}

impl NudgeHold {
    // codes: reasons
    pub fn code(self) -> &'static str {
        match self {
            NudgeHold::Unverified => "endpoint_unverified",
            NudgeHold::Off => "nudge_off",
        }
    }
}

/// Whether a nudge may go out, before the checks every send makes (connected, on, egress, setter).
pub fn decide_nudge(state: NudgeState) -> Result<(), NudgeHold> {
    if !state.verified {
        return Err(NudgeHold::Unverified);
    }
    if state.opted_in_version != Some(state.version) {
        return Err(NudgeHold::Off);
    }
    Ok(())
}

/// The endpoint as a challenge or an opt-in sees it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Registration {
    pub version: u64,
    pub delivery: Delivery,
    pub enabled: bool,
    pub verified: bool,
    pub verify_attempts: i64,
}

/// Why a challenge or an opt-in is refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    NoEndpoint,
    NotNudge,
    SwitchedOff,
    Exhausted,
    RateLimited,
    Unverified,
    Changed,
}

impl Refusal {
    /// The HTTP status and error code each answers.
    // codes: errors
    pub fn code(self) -> (u16, &'static str) {
        match self {
            Refusal::NoEndpoint => (404, "no_endpoint"),
            Refusal::NotNudge => (409, "not_a_nudge_endpoint"),
            Refusal::SwitchedOff => (409, "endpoint_switched_off"),
            Refusal::Exhausted => (429, "verify_attempts_exhausted"),
            Refusal::RateLimited => (429, "verify_rate_limited"),
            Refusal::Unverified => (409, "endpoint_unverified"),
            Refusal::Changed => (409, "endpoint_changed"),
        }
    }
}

/// What a request to verify does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VerifyStart {
    /// Already proved for this secret: nothing is sent.
    AlreadyVerified,
    /// Send a new challenge, counted as one attempt.
    Challenge,
}

/// Decides a request to verify the endpoint. Only a nudge endpoint that's on is challenged, only [`MAX_VERIFY_ATTEMPTS`]
/// times for one signing secret, and only [`MAX_VERIFY_PER_WINDOW`] times for the agent in the last hour, of which
/// `recent` have been sent.
pub fn decide_verify(current: Option<Registration>, recent: i64) -> Result<VerifyStart, Refusal> {
    let current = current.ok_or(Refusal::NoEndpoint)?;
    if current.delivery != Delivery::Nudge {
        return Err(Refusal::NotNudge);
    }
    if current.verified {
        return Ok(VerifyStart::AlreadyVerified);
    }
    if !current.enabled {
        return Err(Refusal::SwitchedOff);
    }
    if current.verify_attempts >= MAX_VERIFY_ATTEMPTS {
        return Err(Refusal::Exhausted);
    }
    if recent >= MAX_VERIFY_PER_WINDOW {
        return Err(Refusal::RateLimited);
    }
    Ok(VerifyStart::Challenge)
}

/// What an answer to a challenge does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VerifyResult {
    Verified,
    Failed,
    /// The registration or its challenge changed while the challenge was out, so the answer is for nothing current.
    Stale,
}

/// Decides an answer to a challenge. It counts only for the registration and challenge it was sent for.
pub fn decide_verify_result(
    sent_version: u64,
    sent_challenge: &str,
    current_version: Option<u64>,
    current_challenge: Option<&str>,
    proof_ok: bool,
) -> VerifyResult {
    if current_version != Some(sent_version) || current_challenge != Some(sent_challenge) {
        return VerifyResult::Stale;
    }
    if proof_ok {
        VerifyResult::Verified
    } else {
        VerifyResult::Failed
    }
}

/// Decides the owner's opt-in. Switching on names the version the owner was shown, so a URL changed since can't be
/// switched on unseen, and it must be a verified nudge endpoint. Switching off always works.
pub fn decide_opt_in(
    current: Option<Registration>,
    on: bool,
    version: Option<u64>,
) -> Result<(), Refusal> {
    if !on {
        return Ok(());
    }
    let current = current.ok_or(Refusal::NoEndpoint)?;
    if current.delivery != Delivery::Nudge {
        return Err(Refusal::NotNudge);
    }
    if version != Some(current.version) {
        return Err(Refusal::Changed);
    }
    if !current.verified {
        return Err(Refusal::Unverified);
    }
    Ok(())
}

/// How long to wait before retrying a nudge that failed, by how many times it has been tried: [`RETRY_BASE_SECS`],
/// doubling, up to [`RETRY_MAX_SECS`].
pub fn retry_delay_secs(tries: i64) -> u32 {
    let doublings = tries.saturating_sub(1).clamp(0, 16) as u32;
    RETRY_BASE_SECS
        .saturating_mul(1u32 << doublings)
        .min(RETRY_MAX_SECS)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "a2asec_test";
    const CHALLENGE: &str = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

    #[test]
    fn delivery_names_round_trip_and_nothing_else_parses() {
        for d in [Delivery::Offers, Delivery::Nudge] {
            assert_eq!(Delivery::from_name(d.name()), Some(d));
        }
        for bad in ["", "Nudge", "offer", "push"] {
            assert_eq!(Delivery::from_name(bad), None, "{bad}");
        }
    }

    #[test]
    fn the_proof_matches_a_known_value_and_binds_every_input() {
        // Computed separately with openssl: printf '%s' 'podster-endpoint-proof/1.agt_a.3.<CHALLENGE>' |
        // openssl dgst -sha256 -hmac a2asec_test
        assert_eq!(
            proof(SECRET, "agt_a", 3, CHALLENGE),
            "75058ca616bb34a72bd9d06c4a1d6b55203f0fdb9009db1dedb068ffd27fa543"
        );
        let base = proof(SECRET, "agt_a", 3, CHALLENGE);
        assert_ne!(base, proof("other", "agt_a", 3, CHALLENGE));
        assert_ne!(base, proof(SECRET, "agt_b", 3, CHALLENGE));
        assert_ne!(base, proof(SECRET, "agt_a", 4, CHALLENGE));
        assert_ne!(
            base,
            proof(SECRET, "agt_a", 3, &CHALLENGE.replace('0', "1"))
        );
        // Not a request signature over the same words.
        assert!(!crate::sign(SECRET, 0, CHALLENGE).contains(&base));
    }

    #[test]
    fn only_the_exact_proof_matches() {
        let good = proof(SECRET, "agt_a", 3, CHALLENGE);
        assert!(proof_matches(SECRET, "agt_a", 3, CHALLENGE, &good));
        assert!(!proof_matches(SECRET, "agt_a", 4, CHALLENGE, &good));
        assert!(!proof_matches("other", "agt_a", 3, CHALLENGE, &good));
        for bad in [
            String::new(),
            good.to_uppercase(),
            good[..62].to_string(),
            format!("{good}00"),
            format!("+{}", &good[1..]),
            CHALLENGE.to_string(),
        ] {
            assert!(!proof_matches(SECRET, "agt_a", 3, CHALLENGE, &bad), "{bad}");
        }
    }

    #[test]
    fn challenges_are_64_lowercase_hex() {
        assert!(valid_challenge(CHALLENGE));
        assert!(!valid_challenge(&CHALLENGE.to_uppercase()));
        assert!(!valid_challenge(&CHALLENGE[1..]));
        assert!(!valid_challenge(""));
    }

    #[test]
    fn a_left_out_mode_keeps_the_one_in_force_and_is_offers_for_a_new_registration() {
        use Delivery::{Nudge, Offers};
        assert_eq!(delivery_for_set(None, Some(Nudge)), Nudge);
        assert_eq!(delivery_for_set(None, Some(Offers)), Offers);
        assert_eq!(delivery_for_set(None, None), Offers);
        assert_eq!(delivery_for_set(Some(Offers), Some(Nudge)), Offers);
        assert_eq!(delivery_for_set(Some(Nudge), None), Nudge);
    }

    #[test]
    fn a_new_delivery_mode_is_a_new_registration() {
        let url = "https://a.acme.dev/x";
        let moved = decide_set_for(
            Some(url),
            Delivery::Offers,
            4,
            url,
            Delivery::Nudge,
            TokenChange::Unchanged,
            false,
        );
        assert_eq!(
            moved,
            SetOutcome {
                version: 5,
                new_secret: true,
                keep_token: false
            }
        );
        let same = decide_set_for(
            Some(url),
            Delivery::Nudge,
            5,
            url,
            Delivery::Nudge,
            TokenChange::Unchanged,
            false,
        );
        assert_eq!(
            same,
            SetOutcome {
                version: 5,
                new_secret: false,
                keep_token: true
            }
        );
    }

    #[test]
    fn a_nudge_needs_proof_and_the_owners_opt_in_for_this_version() {
        let state = |verified, opted| NudgeState {
            version: 2,
            verified,
            opted_in_version: opted,
        };
        assert_eq!(decide_nudge(state(false, None)), Err(NudgeHold::Unverified));
        assert_eq!(
            decide_nudge(state(false, Some(2))),
            Err(NudgeHold::Unverified)
        );
        assert_eq!(decide_nudge(state(true, None)), Err(NudgeHold::Off));
        assert_eq!(decide_nudge(state(true, Some(1))), Err(NudgeHold::Off));
        assert_eq!(decide_nudge(state(true, Some(2))), Ok(()));
        assert_eq!(NudgeHold::Unverified.code(), "endpoint_unverified");
        assert_eq!(NudgeHold::Off.code(), "nudge_off");
    }

    fn registration() -> Registration {
        Registration {
            version: 2,
            delivery: Delivery::Nudge,
            enabled: true,
            verified: false,
            verify_attempts: 0,
        }
    }

    #[test]
    fn verifying_challenges_only_an_unverified_nudge_endpoint_thats_on_and_not_exhausted() {
        assert_eq!(decide_verify(None, 0), Err(Refusal::NoEndpoint));
        assert_eq!(
            decide_verify(Some(registration()), 0),
            Ok(VerifyStart::Challenge)
        );
        let offers = Registration {
            delivery: Delivery::Offers,
            ..registration()
        };
        assert_eq!(decide_verify(Some(offers), 0), Err(Refusal::NotNudge));
        let done = Registration {
            verified: true,
            ..registration()
        };
        assert_eq!(
            decide_verify(Some(done), 0),
            Ok(VerifyStart::AlreadyVerified)
        );
        let off = Registration {
            enabled: false,
            ..registration()
        };
        assert_eq!(decide_verify(Some(off), 0), Err(Refusal::SwitchedOff));
        let last = Registration {
            verify_attempts: MAX_VERIFY_ATTEMPTS - 1,
            ..registration()
        };
        assert_eq!(decide_verify(Some(last), 0), Ok(VerifyStart::Challenge));
        let spent = Registration {
            verify_attempts: MAX_VERIFY_ATTEMPTS,
            ..registration()
        };
        assert_eq!(decide_verify(Some(spent), 0), Err(Refusal::Exhausted));
    }

    #[test]
    fn the_agent_gets_ten_challenges_an_hour_whatever_its_secret() {
        assert_eq!(
            decide_verify(Some(registration()), MAX_VERIFY_PER_WINDOW - 1),
            Ok(VerifyStart::Challenge)
        );
        assert_eq!(
            decide_verify(Some(registration()), MAX_VERIFY_PER_WINDOW),
            Err(Refusal::RateLimited)
        );
        // A verified endpoint sends nothing, so it isn't limited.
        let done = Registration {
            verified: true,
            ..registration()
        };
        assert_eq!(
            decide_verify(Some(done), MAX_VERIFY_PER_WINDOW),
            Ok(VerifyStart::AlreadyVerified)
        );
        assert_eq!(MAX_VERIFY_PER_WINDOW, 10);
        assert_eq!(VERIFY_WINDOW_MS, 3_600_000);
        assert_eq!(Refusal::RateLimited.code(), (429, "verify_rate_limited"));
    }

    #[test]
    fn an_answer_counts_only_for_the_registration_and_challenge_it_was_sent_for() {
        let other = CHALLENGE.replace('0', "2");
        assert_eq!(
            decide_verify_result(2, CHALLENGE, Some(2), Some(CHALLENGE), true),
            VerifyResult::Verified
        );
        assert_eq!(
            decide_verify_result(2, CHALLENGE, Some(2), Some(CHALLENGE), false),
            VerifyResult::Failed
        );
        for (version, challenge) in [
            (Some(3), Some(CHALLENGE)),
            (None, Some(CHALLENGE)),
            (Some(2), Some(other.as_str())),
            (Some(2), None),
        ] {
            assert_eq!(
                decide_verify_result(2, CHALLENGE, version, challenge, true),
                VerifyResult::Stale
            );
        }
    }

    #[test]
    fn the_owner_switches_on_only_the_verified_version_they_were_shown() {
        let verified = Registration {
            verified: true,
            ..registration()
        };
        assert_eq!(decide_opt_in(Some(verified), true, Some(2)), Ok(()));
        assert_eq!(
            decide_opt_in(Some(verified), true, Some(1)),
            Err(Refusal::Changed)
        );
        assert_eq!(
            decide_opt_in(Some(verified), true, None),
            Err(Refusal::Changed)
        );
        assert_eq!(
            decide_opt_in(Some(registration()), true, Some(2)),
            Err(Refusal::Unverified)
        );
        let offers = Registration {
            delivery: Delivery::Offers,
            ..verified
        };
        assert_eq!(
            decide_opt_in(Some(offers), true, Some(2)),
            Err(Refusal::NotNudge)
        );
        assert_eq!(decide_opt_in(None, true, Some(2)), Err(Refusal::NoEndpoint));
        // Off always works, even with nothing to switch off.
        assert_eq!(decide_opt_in(None, false, None), Ok(()));
        assert_eq!(decide_opt_in(Some(registration()), false, Some(9)), Ok(()));
    }

    #[test]
    fn retries_back_off_doubling_to_a_cap() {
        assert_eq!(retry_delay_secs(0), 60);
        assert_eq!(retry_delay_secs(1), 60);
        assert_eq!(retry_delay_secs(2), 120);
        assert_eq!(retry_delay_secs(3), 240);
        assert_eq!(retry_delay_secs(4), 480);
        assert_eq!(retry_delay_secs(5), 900);
        assert_eq!(retry_delay_secs(50), 900);
        assert_eq!(retry_delay_secs(-3), 60);
    }
}
