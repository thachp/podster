//! An agent's A2A endpoint: M3 step 11. No I/O.
//!
//! Design: [ADR 0007](../../../docs/adr/0007-a2a.md#outbound-offers-to-a-registered-endpoint), decisions 119, 122 and 134.
//! One endpoint per agent, set by the agent or its organization's admin, beside wake. It grants nothing in any room.
//!
//! - **The URL** follows wake's rules exactly (decision 134): [`check_endpoint_url`] is [`crate::check_wake_url`].
//! - **The registration version** goes up whenever the URL changes, including setting one after a delete, and never goes
//!   back, so every offer attempt can pin the one it was sent to and a re-pointed endpoint can't answer for it.
//! - **The signing secret** is new with each version and shown once. Requests are signed as wake's are, with
//!   [`crate::sign`].
//! - **The bearer token** is optional and write-only. It's sealed with AES-256-GCM under a key from a Worker secret the
//!   owner sets, bound to the agent and the registration version, and it's cleared whenever the version changes, on
//!   delete, and on disconnect.
//! - **Three failed requests in a row** switch the endpoint off. Any success resets the count. Setting it again turns it
//!   back on.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};

/// Failed requests in a row that switch an endpoint off, as for wake.
pub const MAX_ENDPOINT_FAILURES: i64 = 3;
/// The longest bearer token Podster stores.
pub const MAX_TOKEN_BYTES: usize = 4096;
/// The sealing key's length: AES-256.
pub const KEY_BYTES: usize = 32;
/// AES-GCM's nonce length.
pub const NONCE_BYTES: usize = 12;
/// Every sealed token starts with this, so a later scheme can be told apart.
const SEALED_PREFIX: &str = "v1:";

/// The URL rule is wake's (decision 134): `https`, a public DNS name, no IP address in any form, no credentials, the default
/// port, not `podster.dev`. Returns the normalized URL.
pub fn check_endpoint_url(raw: &str) -> Result<String, crate::Refusal> {
    crate::check_wake_url(raw)
}

/// Whether a bearer token may be stored: 1 to [`MAX_TOKEN_BYTES`] bytes of printable ASCII with no whitespace, which is
/// what can go in an `Authorization: Bearer` header.
pub fn valid_bearer_token(token: &str) -> bool {
    !token.is_empty()
        && token.len() <= MAX_TOKEN_BYTES
        && token.bytes().all(|b| b.is_ascii_graphic())
}

/// What setting an endpoint does to its registration, given what's registered now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SetOutcome {
    /// The registration version after this.
    pub version: u64,
    /// Whether a new signing secret is made, and shown once. True whenever the version moves.
    pub new_secret: bool,
    /// Whether the stored token, if any, is kept. Only when the version doesn't move, and the request didn't replace or clear
    /// it.
    pub keep_token: bool,
}

/// What the request said about the token.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TokenChange {
    /// Not mentioned: keep it if the URL stays the same, and clear it otherwise.
    Unchanged,
    /// `null`: clear it.
    Clear,
    /// A new token: replace it.
    Replace,
}

/// Decides the version, secret and token after a set. `current` is the registered URL and the highest version ever used,
/// with `None` as the URL after a delete or when none was ever set. `url` is the new, already checked URL. `rotate_secret`
/// asks for a new signing secret for the same URL, so a lost one needs no delete. It doesn't move the version, since the
/// endpoint is the same one: attempts pinned to it carry on, signed with the new secret from then on.
pub fn decide_set(
    current_url: Option<&str>,
    highest_version: u64,
    url: &str,
    token: TokenChange,
    rotate_secret: bool,
) -> SetOutcome {
    if current_url == Some(url) {
        return SetOutcome {
            version: highest_version,
            new_secret: rotate_secret,
            keep_token: token == TokenChange::Unchanged,
        };
    }
    SetOutcome {
        version: highest_version.saturating_add(1),
        new_secret: true,
        keep_token: false,
    }
}

/// What a report of one request to the endpoint does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReportOutcome {
    /// For a version that isn't the current one, or an endpoint that's deleted: changes nothing, since how an old URL
    /// answered says nothing about the new one.
    Ignored,
    /// A success: the count goes back to 0.
    Reset,
    /// A failure, with the new count, while it stays on.
    Counted(i64),
    /// The failure that reached [`MAX_ENDPOINT_FAILURES`]: it switches off until set again.
    SwitchedOff,
}

/// Counts one request's result. A failure is any of what ADR 0007 lists: a timeout or HTTP error, a redirect, a response
/// over 64 KB, a remote task ID that fails its check, or a response that isn't valid JSON-RPC. The consumer decides which
/// happened, and reports only `ok`. A report for an endpoint that's already off changes nothing more.
pub fn decide_report(
    current_version: Option<u64>,
    enabled: bool,
    failures: i64,
    reported_version: u64,
    ok: bool,
) -> ReportOutcome {
    if current_version != Some(reported_version) || !enabled {
        return ReportOutcome::Ignored;
    }
    if ok {
        return ReportOutcome::Reset;
    }
    let failures = failures.saturating_add(1);
    if failures >= MAX_ENDPOINT_FAILURES {
        ReportOutcome::SwitchedOff
    } else {
        ReportOutcome::Counted(failures)
    }
}

/// Why sealing or opening failed. Carries nothing secret.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SealError {
    /// The key isn't [`KEY_BYTES`] long.
    BadKey,
    /// The stored value isn't one this sealed, or it was sealed for another agent or version, or under another key.
    NotOpenable,
}

/// What a token is bound to, so a sealed value copied to another agent or kept past a version change can't be opened.
fn binding(agent: &str, version: u64) -> String {
    format!("podster-a2a-token:{agent}:{version}")
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn unhex(text: &str) -> Option<Vec<u8>> {
    // `from_str_radix` would take a leading `+`, so every character must be a hex digit.
    if !text.len().is_multiple_of(2) || !text.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|at| {
            text.get(at..at + 2)
                .and_then(|pair| u8::from_str_radix(pair, 16).ok())
        })
        .collect()
}

/// Seals a token for storage. `nonce` must be fresh for every call under the same key: the caller draws it from a
/// cryptographic random source. The result holds no plaintext and is safe to store, never to return.
pub fn seal(
    key: &[u8],
    nonce: &[u8; NONCE_BYTES],
    agent: &str,
    version: u64,
    token: &str,
) -> Result<String, SealError> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| SealError::BadKey)?;
    let aad = binding(agent, version);
    let sealed = cipher
        .encrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: token.as_bytes(),
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| SealError::BadKey)?;
    Ok(format!("{SEALED_PREFIX}{}{}", hex(nonce), hex(&sealed)))
}

/// Opens a sealed token, only for the agent and version it was sealed for.
pub fn open(key: &[u8], agent: &str, version: u64, stored: &str) -> Result<String, SealError> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| SealError::BadKey)?;
    let bytes = stored
        .strip_prefix(SEALED_PREFIX)
        .and_then(unhex)
        .ok_or(SealError::NotOpenable)?;
    if bytes.len() <= NONCE_BYTES {
        return Err(SealError::NotOpenable);
    }
    let (nonce, sealed) = bytes.split_at(NONCE_BYTES);
    let aad = binding(agent, version);
    let plain = cipher
        .decrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: sealed,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| SealError::NotOpenable)?;
    String::from_utf8(plain).map_err(|_| SealError::NotOpenable)
}

/// Seals a short value that leaves Podster and comes back, such as an Explore cursor (M4 step 14), so whoever holds it can
/// neither read nor change it. `label` names what it is and is bound in, so a value sealed as one thing never opens as
/// another. The result is lower-case hex only: the nonce, then the ciphertext with its tag. `nonce` must be fresh for every
/// call under the same key.
pub fn seal_labeled(
    key: &[u8],
    nonce: &[u8; NONCE_BYTES],
    label: &str,
    value: &str,
) -> Result<String, SealError> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| SealError::BadKey)?;
    let sealed = cipher
        .encrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: value.as_bytes(),
                aad: format!("podster-sealed:{label}").as_bytes(),
            },
        )
        .map_err(|_| SealError::BadKey)?;
    Ok(format!("{}{}", hex(nonce), hex(&sealed)))
}

/// Opens what `seal_labeled` made under the same key and label. Anything else, changed by a single bit, is `NotOpenable`.
pub fn open_labeled(key: &[u8], label: &str, sealed: &str) -> Result<String, SealError> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| SealError::BadKey)?;
    let bytes = unhex(sealed).ok_or(SealError::NotOpenable)?;
    if bytes.len() <= NONCE_BYTES {
        return Err(SealError::NotOpenable);
    }
    let (nonce, body) = bytes.split_at(NONCE_BYTES);
    let plain = cipher
        .decrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: body,
                aad: format!("podster-sealed:{label}").as_bytes(),
            },
        )
        .map_err(|_| SealError::NotOpenable)?;
    String::from_utf8(plain).map_err(|_| SealError::NotOpenable)
}

/// Reads the Worker secret holding the sealing key: 64 hex characters. Anything else isn't a key, and tokens can't be set.
pub fn parse_key(secret: &str) -> Option<Vec<u8>> {
    unhex(secret.trim()).filter(|key| key.len() == KEY_BYTES)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]
mod tests {
    use super::*;

    use sha2::{Digest, Sha256};

    #[test]
    fn a_labeled_value_opens_only_under_its_key_and_label() {
        let key = [7_u8; KEY_BYTES];
        let sealed = seal_labeled(
            &key,
            &[1; NONCE_BYTES],
            "explore-cursor",
            "1794256373910.pub_ab",
        )
        .unwrap();
        assert!(sealed
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
        assert!(!sealed.contains("pub_ab"));
        assert_eq!(
            open_labeled(&key, "explore-cursor", &sealed).unwrap(),
            "1794256373910.pub_ab"
        );
        assert_eq!(
            open_labeled(&key, "other", &sealed),
            Err(SealError::NotOpenable)
        );
        assert_eq!(
            open_labeled(&[8; KEY_BYTES], "explore-cursor", &sealed),
            Err(SealError::NotOpenable)
        );
        // One flipped character, a cut one, or nothing past the nonce, never opens.
        let mut flipped = sealed.clone().into_bytes();
        let last = flipped.len() - 1;
        flipped[last] = if flipped[last] == b'0' { b'1' } else { b'0' };
        assert_eq!(
            open_labeled(&key, "explore-cursor", &String::from_utf8(flipped).unwrap()),
            Err(SealError::NotOpenable)
        );
        assert_eq!(
            open_labeled(&key, "explore-cursor", &sealed[..sealed.len() - 2]),
            Err(SealError::NotOpenable)
        );
        assert_eq!(
            open_labeled(&key, "explore-cursor", &sealed[..NONCE_BYTES * 2]),
            Err(SealError::NotOpenable)
        );
        // An unsealed cursor of the old form doesn't open.
        let plain: String = "1794256373910.pub_ab"
            .bytes()
            .map(|b| format!("{b:02x}"))
            .collect();
        assert_eq!(
            open_labeled(&key, "explore-cursor", &plain),
            Err(SealError::NotOpenable)
        );
        // A fresh nonce gives a different value for the same position.
        assert_ne!(
            sealed,
            seal_labeled(
                &key,
                &[2; NONCE_BYTES],
                "explore-cursor",
                "1794256373910.pub_ab"
            )
            .unwrap()
        );
    }

    /// Test bytes derived at run time from a label, so no key or nonce is written into the tests as a literal.
    fn test_bytes(label: &str, len: usize) -> Vec<u8> {
        let mut out = Vec::with_capacity(len);
        let mut round: u32 = 0;
        while out.len() < len {
            let mut hasher = Sha256::new();
            hasher.update(label.as_bytes());
            hasher.update(round.to_be_bytes());
            out.extend(hasher.finalize());
            round += 1;
        }
        out.truncate(len);
        out
    }

    fn key() -> Vec<u8> {
        test_bytes("key", KEY_BYTES)
    }

    fn nonce(label: &str) -> [u8; NONCE_BYTES] {
        test_bytes(label, NONCE_BYTES).try_into().unwrap()
    }

    #[test]
    fn the_url_rule_is_wakes() {
        for url in [
            "https://agent.example.org/a2a",
            "http://agent.example.org/a2a",
            "https://10.0.0.1/a2a",
            "https://agent.example.org:8443/a2a",
            "https://user:pw@agent.example.org/a2a",
            "https://podster.dev/a2a",
        ] {
            assert_eq!(check_endpoint_url(url), crate::check_wake_url(url), "{url}");
        }
        assert!(check_endpoint_url("https://agents.acme.dev/a2a").is_ok());
        assert!(check_endpoint_url("http://agents.acme.dev/a2a").is_err());
    }

    #[test]
    fn bearer_tokens_are_header_safe_and_bounded() {
        assert!(valid_bearer_token("abc.DEF-123_~+/="));
        assert!(valid_bearer_token(&"t".repeat(MAX_TOKEN_BYTES)));
        for bad in ["", "a b", "a\nb", "é", &"t".repeat(MAX_TOKEN_BYTES + 1)] {
            assert!(!valid_bearer_token(bad), "{bad:?}");
        }
    }

    #[test]
    fn a_new_url_moves_the_version_makes_a_secret_and_clears_the_token() {
        for token in [
            TokenChange::Unchanged,
            TokenChange::Clear,
            TokenChange::Replace,
        ] {
            let set = decide_set(
                Some("https://a.acme.dev/x"),
                4,
                "https://b.acme.dev/x",
                token,
                false,
            );
            assert_eq!(
                set,
                SetOutcome {
                    version: 5,
                    new_secret: true,
                    keep_token: false
                }
            );
        }
    }

    #[test]
    fn setting_after_a_delete_or_for_the_first_time_moves_the_version() {
        assert_eq!(
            decide_set(
                None,
                0,
                "https://a.acme.dev/x",
                TokenChange::Unchanged,
                false
            )
            .version,
            1
        );
        // Deleted at version 4: the same URL again is a new registration, so version 4's attempts stay ended.
        let again = decide_set(
            None,
            4,
            "https://a.acme.dev/x",
            TokenChange::Unchanged,
            false,
        );
        assert_eq!(
            again,
            SetOutcome {
                version: 5,
                new_secret: true,
                keep_token: false
            }
        );
    }

    #[test]
    fn the_same_url_keeps_the_version_and_secret_and_keeps_the_token_unless_told() {
        let url = "https://a.acme.dev/x";
        assert_eq!(
            decide_set(Some(url), 4, url, TokenChange::Unchanged, false),
            SetOutcome {
                version: 4,
                new_secret: false,
                keep_token: true
            }
        );
        assert!(!decide_set(Some(url), 4, url, TokenChange::Clear, false).keep_token);
        assert!(!decide_set(Some(url), 4, url, TokenChange::Replace, false).keep_token);
    }

    #[test]
    fn rotating_the_secret_for_the_same_url_keeps_the_version_and_the_token() {
        let url = "https://a.acme.dev/x";
        assert_eq!(
            decide_set(Some(url), 4, url, TokenChange::Unchanged, true),
            SetOutcome {
                version: 4,
                new_secret: true,
                keep_token: true
            }
        );
        // With a new URL the secret is new anyway.
        assert!(
            decide_set(
                Some(url),
                4,
                "https://b.acme.dev/x",
                TokenChange::Unchanged,
                true
            )
            .new_secret
        );
    }

    #[test]
    fn three_failures_in_a_row_switch_it_off_and_a_success_resets() {
        assert_eq!(
            decide_report(Some(2), true, 0, 2, false),
            ReportOutcome::Counted(1)
        );
        assert_eq!(
            decide_report(Some(2), true, 1, 2, false),
            ReportOutcome::Counted(2)
        );
        assert_eq!(
            decide_report(Some(2), true, 2, 2, false),
            ReportOutcome::SwitchedOff
        );
        assert_eq!(
            decide_report(Some(2), true, 2, 2, true),
            ReportOutcome::Reset
        );
    }

    #[test]
    fn a_report_for_another_version_a_deleted_or_a_switched_off_endpoint_changes_nothing() {
        assert_eq!(
            decide_report(Some(3), true, 2, 2, false),
            ReportOutcome::Ignored
        );
        assert_eq!(
            decide_report(None, true, 2, 2, false),
            ReportOutcome::Ignored
        );
        assert_eq!(
            decide_report(Some(2), false, 3, 2, true),
            ReportOutcome::Ignored
        );
    }

    #[test]
    fn a_sealed_token_opens_only_for_its_agent_version_and_key() {
        let sealed = seal(&key(), &nonce("first"), "agt_1", 4, "secret-token").unwrap();
        assert!(sealed.starts_with("v1:"));
        assert!(!sealed.contains("secret-token"));
        assert_eq!(open(&key(), "agt_1", 4, &sealed).unwrap(), "secret-token");
        assert_eq!(
            open(&key(), "agt_2", 4, &sealed),
            Err(SealError::NotOpenable)
        );
        assert_eq!(
            open(&key(), "agt_1", 5, &sealed),
            Err(SealError::NotOpenable)
        );
        assert_eq!(
            open(&test_bytes("other key", KEY_BYTES), "agt_1", 4, &sealed),
            Err(SealError::NotOpenable)
        );
    }

    #[test]
    fn a_tampered_or_malformed_value_doesnt_open() {
        let sealed = seal(&key(), &nonce("first"), "agt_1", 4, "secret-token").unwrap();
        let mut flipped = sealed.clone().into_bytes();
        let last = flipped.len() - 1;
        flipped[last] = if flipped[last] == b'0' { b'1' } else { b'0' };
        let flipped = String::from_utf8(flipped).unwrap();
        for bad in [flipped.as_str(), "v1:", "v1:zz", "v2:00", "", &sealed[3..]] {
            assert_eq!(
                open(&key(), "agt_1", 4, bad),
                Err(SealError::NotOpenable),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn a_fresh_nonce_gives_a_different_sealed_value() {
        let one = seal(&key(), &nonce("first"), "agt_1", 4, "t").unwrap();
        let two = seal(&key(), &nonce("second"), "agt_1", 4, "t").unwrap();
        assert_ne!(one, two);
    }

    #[test]
    fn hex_with_a_sign_or_other_characters_isnt_hex() {
        assert!(parse_key(&format!("+a{}", "0a".repeat(31))).is_none());
        assert!(parse_key(&format!("-a{}", "0a".repeat(31))).is_none());
        let sealed = seal(&key(), &nonce("first"), "agt_1", 4, "t").unwrap();
        let signed = format!("v1:+{}", &sealed[4..]);
        assert_eq!(
            open(&key(), "agt_1", 4, &signed),
            Err(SealError::NotOpenable)
        );
    }

    #[test]
    fn keys_are_64_hex_characters() {
        assert_eq!(parse_key(&"0a".repeat(32)).unwrap().len(), 32);
        assert!(parse_key(&"0a".repeat(31)).is_none());
        assert!(parse_key("not hex").is_none());
        assert_eq!(
            seal(&test_bytes("short key", 16), &nonce("first"), "a", 1, "t"),
            Err(SealError::BadKey)
        );
    }
}
