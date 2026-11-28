//! The key that signs preview tickets and sessions (M8 step 7; the preview plan, `docs/m8-preview-plan.md`, 5.4;
//! decision 258). **The owner makes it, through the wizard, and sets it as the API's secret `PREVIEW_TICKET_KEY`;**
//! nothing in Podster ever generates one, and no key is in the repository. The content Worker gets only the public
//! half, by key ID, through `scripts/deploy-content`'s configuration (M8 step 8), so it can check a token and never
//! make one.
//!
//! **The secret's form:** `<kid>:<seed>`, where `kid` is 1 to 64 ASCII letters, digits, `-` and `_`
//! (`podster_core::preview_access::is_key_id`), which names the public key in the content Worker's configuration, and
//! `seed` is the Ed25519 private key's 32-byte seed as 64 hexadecimal characters. Anything else is no key: the API
//! then answers `/v1/preview-access` as if previews were off, and signs nothing.
//!
//! **Rotation:** the owner sets a new key with a new `kid` and moves the old one to `PREVIEW_TICKET_KEY_PREVIOUS`,
//! which the API never reads (it signs with the current key only); the content Worker keeps the old public key for an
//! hour, the longest a session lives, as `REPO_TOKEN_KEY` rotates (`docs/staging.md`).
//!
//! Nothing here logs, and a key's `Debug` shows its ID only.

use ed25519_dalek::{Signer, SigningKey};
use podster_core::preview_access::is_key_id;

/// The length of an Ed25519 seed, in bytes.
const SEED_BYTES: usize = 32;

/// The signing key, read from the owner's secret.
pub struct PreviewKey {
    kid: String,
    signing: SigningKey,
}

impl std::fmt::Debug for PreviewKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PreviewKey")
            .field("kid", &self.kid)
            .finish_non_exhaustive()
    }
}

fn unhex(text: &str) -> Option<Vec<u8>> {
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

impl PreviewKey {
    /// Reads `<kid>:<64 hex characters>`, with no space around either part. `None` for anything else.
    pub fn parse(secret: &str) -> Option<PreviewKey> {
        let (kid, seed) = secret.split_once(':')?;
        if !is_key_id(kid) {
            return None;
        }
        let seed: [u8; SEED_BYTES] = unhex(seed)?.try_into().ok()?;
        Some(PreviewKey {
            kid: kid.to_owned(),
            signing: SigningKey::from_bytes(&seed),
        })
    }

    /// The key's ID, which every token it signs carries as `kid`.
    pub fn kid(&self) -> &str {
        &self.kid
    }

    /// The public half, for a test's check of what was signed. Never needed to sign.
    pub fn public_key(&self) -> [u8; 32] {
        self.signing.verifying_key().to_bytes()
    }

    /// The Ed25519 signature over `message`.
    pub fn sign(&self, message: &[u8]) -> [u8; 64] {
        self.signing.sign(message).to_bytes()
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};

    // A seed made of a repeated byte, for these tests only. It signs nothing anywhere else.
    fn test_secret(kid: &str) -> String {
        format!("{kid}:{}", "4b".repeat(32))
    }

    #[test]
    fn a_key_is_its_id_a_colon_and_a_64_character_hex_seed() {
        let key = PreviewKey::parse(&test_secret("pv-2026_11")).unwrap();
        assert_eq!(key.kid(), "pv-2026_11");
        assert!(PreviewKey::parse(&format!("k1:{}", "4B".repeat(32))).is_some());
    }

    #[test]
    fn anything_else_is_no_key() {
        let seed = "4b".repeat(32);
        for secret in [
            String::new(),
            seed.clone(),
            format!(":{seed}"),
            format!("k 1:{seed}"),
            format!("{}:{seed}", "k".repeat(65)),
            format!("k1:{}", "4b".repeat(31)),
            format!("k1:{}", "4b".repeat(33)),
            format!("k1:{seed} "),
            format!(" k1:{seed}"),
            format!("k1: {seed}"),
            format!("k1:+{}", &seed[1..]),
            format!("k1:{}zz", &seed[2..]),
            format!("k1:{seed}:x"),
        ] {
            assert!(PreviewKey::parse(&secret).is_none(), "{secret:?}");
        }
    }

    #[test]
    fn what_it_signs_checks_out_with_its_public_half_and_nothing_else() {
        let key = PreviewKey::parse(&test_secret("k1")).unwrap();
        let other = PreviewKey::parse(&format!("k1:{}", "5c".repeat(32))).unwrap();
        let message = b"podster-preview-token/v1.payload";
        let signature = Signature::from_bytes(&key.sign(message));
        let public = VerifyingKey::from_bytes(&key.public_key()).unwrap();
        assert!(public.verify(message, &signature).is_ok());
        assert!(public
            .verify(b"podster-preview-token/v1.payloae", &signature)
            .is_err());
        let other_public = VerifyingKey::from_bytes(&other.public_key()).unwrap();
        assert!(other_public.verify(message, &signature).is_err());
        // Ed25519 is deterministic: the same key and message sign the same.
        assert_eq!(key.sign(message), key.sign(message));
    }

    #[test]
    fn its_debug_form_shows_the_id_and_never_the_seed() {
        let key = PreviewKey::parse(&test_secret("k1")).unwrap();
        let shown = format!("{key:?}");
        assert!(shown.contains("k1"));
        assert!(!shown.contains("4b4b"));
    }
}
