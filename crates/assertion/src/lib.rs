//! Verifies the gateway's signed assertion. It says who the caller is, never what they may do.
//! Only EdDSA over Ed25519 is accepted, and keys are selected by `kid` so the gateway can rotate them.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub const AUDIENCE: &str = "podster-api";
pub const ISSUER: &str = "podster-gateway";
pub const MAX_LIFETIME_SECS: i64 = 60;
pub const CLOCK_SKEW_SECS: i64 = 5;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Agent,
    Person,
}

/// A fact from the gateway's directory: the organizations this person belongs to, and when they joined each.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub struct TargetMember {
    pub person: String,
    pub orgs: HashMap<String, i64>,
}

/// A fact from the gateway's directory: this person left this organization at this time, in milliseconds.
/// Only the gateway's own removal writes it. The dashboard's forwarding can't add it.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub struct Departure {
    pub person: String,
    pub org: String,
    pub left_at: i64,
}

/// A fact from the gateway's directory: who linked an agent's credential, and when, in milliseconds. A send to the agent's A2A
/// endpoint stops once that person has left the organization since then (ADR 0007). It grants nothing by itself.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub struct Linker {
    pub person: String,
    pub since: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct Identity {
    pub sub: String,
    pub kind: Kind,
    pub org: String,
    pub gen: Option<u64>,
    /// Every organization a person belongs to. `org` is the one they're acting in.
    #[serde(default)]
    pub orgs: Vec<String>,
    /// The organizations this person administers, as recorded by the gateway.
    #[serde(default)]
    pub admin_orgs: Vec<String>,
    /// When this person joined each of their organizations, in milliseconds. A room role older than that was given
    /// during an earlier membership.
    #[serde(default)]
    pub org_since: HashMap<String, i64>,
    /// Present when a person changes another person's room access and the directory has them in an organization.
    /// The API can't read the directory, and this grants nothing by itself.
    #[serde(default)]
    pub target_member: Option<TargetMember>,
    /// Present only when the gateway reports that someone left an organization.
    #[serde(default)]
    pub departure: Option<Departure>,
    /// For an agent, who linked the credential this request came with.
    #[serde(default)]
    pub linker: Option<Linker>,
    /// An agent token this request spends, so it can't be replayed. Absent for callers without one, such as MCP.
    #[serde(default)]
    pub agent_jti: Option<String>,
    /// When that token expires, in seconds. It can't be accepted after this, so the record can go then.
    #[serde(default)]
    pub agent_jti_exp: Option<i64>,
    pub jti: String,
    pub iat: i64,
    pub exp: i64,
}

#[derive(Debug, PartialEq, Eq)]
pub enum AssertionError {
    Malformed,
    UnsupportedAlgorithm,
    UnknownKey,
    BadSignature,
    WrongAudience,
    WrongIssuer,
    Expired,
    NotYetValid,
    LifetimeTooLong,
}

#[derive(Deserialize)]
struct Header {
    alg: String,
    kid: Option<String>,
}

#[derive(Deserialize)]
struct Audience {
    aud: String,
    iss: Option<String>,
}

#[derive(Default)]
pub struct KeySet(HashMap<String, VerifyingKey>);

impl KeySet {
    /// Parses a JSON object of `kid` to base64url public key.
    pub fn from_json(json: &str) -> Result<KeySet, AssertionError> {
        let raw: HashMap<String, String> =
            serde_json::from_str(json).map_err(|_| AssertionError::Malformed)?;
        let mut keys = HashMap::new();
        for (kid, encoded) in raw {
            let bytes = URL_SAFE_NO_PAD
                .decode(encoded)
                .map_err(|_| AssertionError::Malformed)?;
            let bytes: [u8; 32] = bytes.try_into().map_err(|_| AssertionError::Malformed)?;
            keys.insert(
                kid,
                VerifyingKey::from_bytes(&bytes).map_err(|_| AssertionError::Malformed)?,
            );
        }
        Ok(KeySet(keys))
    }
}

/// Verifies a compact JWS and its claims. `now` is seconds since the epoch.
pub fn verify(token: &str, keys: &KeySet, now: i64) -> Result<Identity, AssertionError> {
    let mut parts = token.split('.');
    let (Some(header), Some(payload), Some(signature), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(AssertionError::Malformed);
    };
    let decode = |part: &str| {
        URL_SAFE_NO_PAD
            .decode(part)
            .map_err(|_| AssertionError::Malformed)
    };

    let raw_header = decode(header)?;
    let parsed: Header =
        serde_json::from_slice(&raw_header).map_err(|_| AssertionError::Malformed)?;
    let fields: serde_json::Value =
        serde_json::from_slice(&raw_header).map_err(|_| AssertionError::Malformed)?;
    // This verifier understands no critical extensions, so RFC 7515 requires refusing any.
    if fields.get("crit").is_some() {
        return Err(AssertionError::UnsupportedAlgorithm);
    }
    if parsed.alg != "EdDSA" {
        return Err(AssertionError::UnsupportedAlgorithm);
    }
    let key = parsed
        .kid
        .and_then(|kid| keys.0.get(&kid).copied())
        .ok_or(AssertionError::UnknownKey)?;

    let signature: [u8; 64] = decode(signature)?
        .try_into()
        .map_err(|_| AssertionError::Malformed)?;
    let message = format!("{header}.{payload}");
    key.verify_strict(message.as_bytes(), &Signature::from_bytes(&signature))
        .map_err(|_| AssertionError::BadSignature)?;

    // Claims are only read after the signature checks out.
    let claims = decode(payload)?;
    let audience: Audience =
        serde_json::from_slice(&claims).map_err(|_| AssertionError::Malformed)?;
    if audience.aud != AUDIENCE {
        return Err(AssertionError::WrongAudience);
    }
    if audience.iss.as_deref() != Some(ISSUER) {
        return Err(AssertionError::WrongIssuer);
    }
    let identity: Identity =
        serde_json::from_slice(&claims).map_err(|_| AssertionError::Malformed)?;
    if identity.sub.is_empty() || identity.org.is_empty() || identity.jti.is_empty() {
        return Err(AssertionError::Malformed);
    }
    if identity.kind == Kind::Agent && identity.gen.is_none() {
        return Err(AssertionError::Malformed);
    }
    if identity.exp <= identity.iat {
        return Err(AssertionError::Malformed);
    }
    if identity.exp.saturating_sub(identity.iat) > MAX_LIFETIME_SECS {
        return Err(AssertionError::LifetimeTooLong);
    }
    if now >= identity.exp.saturating_add(CLOCK_SKEW_SECS) {
        return Err(AssertionError::Expired);
    }
    if identity.iat > now.saturating_add(CLOCK_SKEW_SECS) {
        return Err(AssertionError::NotYetValid);
    }
    Ok(identity)
}
