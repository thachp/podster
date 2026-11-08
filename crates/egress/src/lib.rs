//! What Podster may send to an address someone gave it. A wake URL comes from an agent, so it's untrusted: it must be a
//! public HTTPS name, checked when it's set and again before each send.

pub mod endpoint;

use hmac::{Hmac, Mac};
use sha2::Sha256;
use url::{Host, Url};

pub const MAX_URL_BYTES: usize = 2048;
pub const MIN_DEBOUNCE_SECS: i64 = 60;
pub const MAX_DEBOUNCE_SECS: i64 = 24 * 60 * 60;
pub const DEFAULT_DEBOUNCE_SECS: i64 = 15 * 60;

/// Names that can't be a public destination, including ones reserved for local or internal use.
const PRIVATE_SUFFIXES: &[&str] = &[
    "localhost",
    "local",
    "internal",
    "intranet",
    "lan",
    "home",
    "corp",
    "private",
    "test",
    "example",
    "invalid",
    "onion",
    "arpa",
    // Our own service: a wake is for an agent's systems, never for Podster.
    "podster.dev",
];

#[derive(Debug, PartialEq, Eq)]
pub enum Refusal {
    TooLong,
    NotAUrl,
    NotHttps,
    HasCredentials,
    HasFragment,
    NotDefaultPort,
    IpAddress,
    NotPublicName,
}

/// Returns the normalized URL if it's allowed. The parser normalizes hosts first, so forms like `0x7f.1` or
/// `2130706433` arrive here as IP addresses, and encoded or mixed-case names as plain ones.
pub fn check_wake_url(raw: &str) -> Result<String, Refusal> {
    if raw.len() > MAX_URL_BYTES {
        return Err(Refusal::TooLong);
    }
    let url = Url::parse(raw).map_err(|_| Refusal::NotAUrl)?;
    if url.scheme() != "https" {
        return Err(Refusal::NotHttps);
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(Refusal::HasCredentials);
    }
    if url.fragment().is_some() {
        return Err(Refusal::HasFragment);
    }
    // `url` already drops :443, so any port left is another service on that host.
    if url.port().is_some() {
        return Err(Refusal::NotDefaultPort);
    }
    match url.host() {
        Some(Host::Domain(name)) => check_public_name(name)?,
        Some(Host::Ipv4(_) | Host::Ipv6(_)) => return Err(Refusal::IpAddress),
        None => return Err(Refusal::NotAUrl),
    }
    // Measured again after normalizing, which can lengthen it, so what's stored always passes the same check later.
    let normalized = url.to_string();
    if normalized.len() > MAX_URL_BYTES {
        return Err(Refusal::TooLong);
    }
    Ok(normalized)
}

fn check_public_name(name: &str) -> Result<(), Refusal> {
    let name = name.trim_end_matches('.').to_ascii_lowercase();
    let labels: Vec<&str> = name.split('.').collect();
    if labels.len() < 2 || labels.iter().any(|label| label.is_empty()) {
        return Err(Refusal::NotPublicName);
    }
    // A public top-level name is never all digits, and one that is could be read as an address.
    if labels
        .last()
        .is_none_or(|tld| tld.bytes().all(|b| b.is_ascii_digit()))
    {
        return Err(Refusal::NotPublicName);
    }
    let private = PRIVATE_SUFFIXES
        .iter()
        .any(|suffix| name == *suffix || name.ends_with(&format!(".{suffix}")));
    if private {
        return Err(Refusal::NotPublicName);
    }
    Ok(())
}

/// The debounce window to store: the default if none was given, and `None` if it's out of range.
pub fn check_debounce(value: Option<i64>) -> Option<i64> {
    let debounce = value.unwrap_or(DEFAULT_DEBOUNCE_SECS);
    (MIN_DEBOUNCE_SECS..=MAX_DEBOUNCE_SECS)
        .contains(&debounce)
        .then_some(debounce)
}

/// The signature header's value, covering the time and body, so a captured request can't be replayed later or altered.
pub fn sign(secret: &str, unix_seconds: i64, body: &str) -> String {
    #[allow(clippy::expect_used)]
    // HMAC accepts a key of any length, so this can't fail, and there's no error to return.
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("any key length");
    mac.update(format!("{unix_seconds}.{body}").as_bytes());
    let digest: String = mac
        .finalize()
        .into_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("t={unix_seconds},v1={digest}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_public_https_names() {
        for (given, stored) in [
            (
                "https://hooks.example.com/wake",
                "https://hooks.example.com/wake",
            ),
            (
                "https://HOOKS.Example.COM:443/a?b=c",
                "https://hooks.example.com/a?b=c",
            ),
            ("https://a.b.co.uk/", "https://a.b.co.uk/"),
            ("https://example.com", "https://example.com/"),
            ("https://example.com./", "https://example.com./"),
            // A public name that only ends like a private one.
            ("https://notlocal.com/", "https://notlocal.com/"),
            ("https://mylocalhost.org/", "https://mylocalhost.org/"),
            ("https://notpodster.dev/", "https://notpodster.dev/"),
        ] {
            assert_eq!(check_wake_url(given).as_deref(), Ok(stored), "{given}");
        }
    }

    #[test]
    fn refuses_anything_else() {
        for (given, refusal) in [
            ("http://example.com/", Refusal::NotHttps),
            ("ftp://example.com/", Refusal::NotHttps),
            ("file:///etc/passwd", Refusal::NotHttps),
            ("not a url", Refusal::NotAUrl),
            ("https://user:pw@example.com/", Refusal::HasCredentials),
            ("https://user@example.com/", Refusal::HasCredentials),
            ("https://:pw@example.com/", Refusal::HasCredentials),
            ("https://foo/", Refusal::NotPublicName),
            ("https://podster.dev/", Refusal::NotPublicName),
            (
                "https://gateway-staging.podster.dev/mcp",
                Refusal::NotPublicName,
            ),
            ("https://nas.lan/", Refusal::NotPublicName),
            ("https://nas.home/", Refusal::NotPublicName),
            ("https://hr.corp/", Refusal::NotPublicName),
            ("https://hr.intranet/", Refusal::NotPublicName),
            ("https://x.private/", Refusal::NotPublicName),
            ("https://x.invalid/", Refusal::NotPublicName),
            ("https://example.com/#f", Refusal::HasFragment),
            ("https://example.com:8443/", Refusal::NotDefaultPort),
            ("https://127.0.0.1/", Refusal::IpAddress),
            (
                "https://169.254.169.254/latest/meta-data",
                Refusal::IpAddress,
            ),
            ("https://10.0.0.1/", Refusal::IpAddress),
            ("https://[::1]/", Refusal::IpAddress),
            ("https://[fd00::1]/", Refusal::IpAddress),
            // Other ways to write an address.
            ("https://2130706433/", Refusal::IpAddress),
            ("https://0x7f.0.0.1/", Refusal::IpAddress),
            ("https://0177.0.0.1/", Refusal::IpAddress),
            ("https://127.1/", Refusal::IpAddress),
            ("https://localhost/", Refusal::NotPublicName),
            ("https://intranet/", Refusal::NotPublicName),
            ("https://api.localhost/", Refusal::NotPublicName),
            ("https://LOCALHOST./", Refusal::NotPublicName),
            ("https://printer.local/", Refusal::NotPublicName),
            ("https://db.internal/", Refusal::NotPublicName),
            ("https://hook.test/", Refusal::NotPublicName),
            ("https://hook.example/", Refusal::NotPublicName),
            ("https://secret.onion/", Refusal::NotPublicName),
            ("https://1.in-addr.arpa/", Refusal::NotPublicName),
        ] {
            assert_eq!(check_wake_url(given), Err(refusal), "{given}");
        }
        let long = format!("https://example.com/{}", "a".repeat(MAX_URL_BYTES));
        assert_eq!(check_wake_url(&long), Err(Refusal::TooLong));
        // Under the limit as given, and over it once encoded.
        let expands = format!("https://example.com/{}", "é".repeat(MAX_URL_BYTES / 3));
        assert!(expands.len() <= MAX_URL_BYTES);
        assert_eq!(check_wake_url(&expands), Err(Refusal::TooLong));
    }

    #[test]
    fn debounce_stays_within_the_published_range() {
        assert_eq!(check_debounce(None), Some(900));
        assert_eq!(check_debounce(Some(60)), Some(60));
        assert_eq!(check_debounce(Some(86_400)), Some(86_400));
        assert_eq!(check_debounce(Some(59)), None);
        assert_eq!(check_debounce(Some(86_401)), None);
        assert_eq!(check_debounce(Some(-1)), None);
    }

    #[test]
    fn signature_matches_a_known_value_and_covers_time_and_body() {
        // Computed separately with openssl, so this checks the format as well as the code agreeing with itself.
        assert_eq!(
            sign("secret", 1_730_600_000, "{}"),
            "t=1730600000,v1=a53ce417c9caf431331ae71e928a652150ef8a8e04211c583beeddb011769d2b"
        );
        assert_ne!(
            sign("secret", 1_730_600_000, "{}"),
            sign("other", 1_730_600_000, "{}")
        );
        assert_ne!(
            sign("secret", 1_730_600_000, "{}"),
            sign("secret", 1_730_600_001, "{}")
        );
        assert_ne!(
            sign("secret", 1_730_600_000, "{}"),
            sign("secret", 1_730_600_000, "[]")
        );
    }
}
