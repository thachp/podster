//! A GitHub App's private key and the token it signs (M5 step 4, ADR 0009). No I/O, and no signing: the signature itself
//! is made by the runtime's own RSA, from the key this module hands it in the one form that takes.
//!
//! GitHub gives an App's key as a PEM file in PKCS#1 (`BEGIN RSA PRIVATE KEY`). The runtime imports PKCS#8, which is the
//! same key inside a fixed wrapper, so this adds the wrapper. Nothing here is logged or returned in an error.

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
/// How long an App's token asks to live. GitHub allows ten minutes; this asks for nine, and backdates a minute for clock drift.
pub const APP_JWT_SECONDS: i64 = 9 * 60;
const APP_JWT_BACKDATE_SECONDS: i64 = 60;

/// Base64 for a URL, without padding, as a JWT's parts are written.
pub fn base64url(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk.first().copied().unwrap_or(0),
            chunk.get(1).copied().unwrap_or(0),
            chunk.get(2).copied().unwrap_or(0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for (i, shift) in [18u32, 12, 6, 0].into_iter().enumerate() {
            if i <= chunk.len() {
                let digit = B64
                    .get(((n >> shift) & 63) as usize)
                    .copied()
                    .unwrap_or(b'A');
                out.push(match digit {
                    b'+' => '-',
                    b'/' => '_',
                    other => char::from(other),
                });
            }
        }
    }
    out
}

/// Standard base64, as a PEM's body is written. Whitespace is skipped. `None` for anything else that isn't base64.
fn base64_decode(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let mut bits: u32 = 0;
    let mut count = 0u8;
    let mut padding = 0u8;
    for byte in text.bytes() {
        if byte.is_ascii_whitespace() {
            continue;
        }
        if byte == b'=' {
            padding += 1;
            continue;
        }
        // Nothing follows padding.
        if padding > 0 {
            return None;
        }
        let value = B64.iter().position(|b| *b == byte)? as u32;
        bits = (bits << 6) | value;
        count += 1;
        if count == 4 {
            out.extend_from_slice(&[(bits >> 16) as u8, (bits >> 8) as u8, bits as u8]);
            bits = 0;
            count = 0;
        }
    }
    match (count, padding) {
        (0, 0) => {}
        (2, 0 | 2) => out.push((bits >> 4) as u8),
        (3, 0 | 1) => out.extend_from_slice(&[(bits >> 10) as u8, (bits >> 2) as u8]),
        _ => return None,
    }
    Some(out)
}

/// A DER length: one byte under 128, or a count of bytes and then the length.
fn der_length(length: usize) -> Vec<u8> {
    if length < 0x80 {
        return vec![length as u8];
    }
    let bytes: Vec<u8> = length
        .to_be_bytes()
        .into_iter()
        .skip_while(|b| *b == 0)
        .collect();
    let mut out = vec![0x80 | bytes.len() as u8];
    out.extend(bytes);
    out
}

fn der(tag: u8, content: &[u8]) -> Vec<u8> {
    let mut out = vec![tag];
    out.extend(der_length(content.len()));
    out.extend_from_slice(content);
    out
}

/// A PKCS#1 RSA key inside PKCS#8's wrapper: version 0, the RSA algorithm with no parameters, and the key as an octet string.
fn wrap_pkcs1(pkcs1: &[u8]) -> Vec<u8> {
    // SEQUENCE { OID 1.2.840.113549.1.1.1 rsaEncryption, NULL }
    const RSA: [u8; 15] = [
        0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
    ];
    let mut body = vec![0x02, 0x01, 0x00];
    body.extend_from_slice(&RSA);
    body.extend(der(0x04, pkcs1));
    der(0x30, &body)
}

/// The key as PKCS#8 DER, from a PEM in PKCS#1 or PKCS#8. `None` if it's neither, or has more than one block, or isn't a
/// DER sequence inside. The caller says only that the key can't be read, never why or what it held.
pub fn pkcs8_from_pem(pem: &str) -> Option<Vec<u8>> {
    let pem = pem.trim();
    let (label, wrapped) = if pem.starts_with("-----BEGIN RSA PRIVATE KEY-----") {
        ("RSA PRIVATE KEY", true)
    } else if pem.starts_with("-----BEGIN PRIVATE KEY-----") {
        ("PRIVATE KEY", false)
    } else {
        return None;
    };
    let body = pem
        .strip_prefix(&format!("-----BEGIN {label}-----"))?
        .strip_suffix(&format!("-----END {label}-----"))?;
    if body.contains("-----") {
        return None;
    }
    let der_bytes = base64_decode(body)?;
    // Both forms are one DER SEQUENCE, and long enough to be a key.
    if der_bytes.first() != Some(&0x30) || der_bytes.len() < 64 {
        return None;
    }
    Some(if wrapped {
        wrap_pkcs1(&der_bytes)
    } else {
        der_bytes
    })
}

/// The part of an App's JWT that gets signed: an RS256 header and claims naming the App, issued a minute ago and good for
/// nine more. `now` is seconds since the epoch.
pub fn app_jwt_signing_input(app_id: i64, now: i64) -> String {
    let header = r#"{"alg":"RS256","typ":"JWT"}"#;
    let claims = format!(
        r#"{{"iat":{},"exp":{},"iss":"{app_id}"}}"#,
        now - APP_JWT_BACKDATE_SECONDS,
        now + APP_JWT_SECONDS
    );
    format!(
        "{}.{}",
        base64url(header.as_bytes()),
        base64url(claims.as_bytes())
    )
}

/// One GitHub App role's configuration, as the Worker holds it: its App ID, its installation ID and its key as PKCS#8
/// DER from [`pkcs8_from_pem`]. Any part may be missing, for a role that isn't configured.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AppRole {
    pub app_id: Option<i64>,
    pub installation_id: Option<i64>,
    pub key: Option<Vec<u8>>,
}

/// Whether a GitHub App role has an App of its own (M5 step 6, and the M5 security review's F7): `own` against each of
/// `others`, by App ID, by installation ID, and by key. Keys are compared as parsed key material, so the same key
/// written as PKCS#1 for one role and PKCS#8 for another, or with different line breaks, is the same key. A part that
/// either side doesn't have collides with nothing. Every role runs this against both others, so a misconfiguration
/// can never have, say, an agent's token signed with the key of the App that administers repositories.
pub fn role_is_distinct(own: &AppRole, others: &[AppRole]) -> bool {
    fn differs<T: PartialEq>(a: Option<&T>, b: Option<&T>) -> bool {
        a.is_none() || b.is_none() || a != b
    }
    others.iter().all(|other| {
        differs(own.app_id.as_ref(), other.app_id.as_ref())
            && differs(own.installation_id.as_ref(), other.installation_id.as_ref())
            && differs(own.key.as_ref(), other.key.as_ref())
    })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::indexing_slicing)]
    use super::*;

    #[test]
    fn base64url_matches_the_rfcs_vectors_without_padding() {
        for (plain, encoded) in [
            ("", ""),
            ("f", "Zg"),
            ("fo", "Zm8"),
            ("foo", "Zm9v"),
            ("foob", "Zm9vYg"),
            ("fooba", "Zm9vYmE"),
            ("foobar", "Zm9vYmFy"),
        ] {
            assert_eq!(base64url(plain.as_bytes()), encoded);
        }
        assert_eq!(base64url(&[0xfb, 0xff, 0xfe]), "-__-");
    }

    #[test]
    fn base64_decodes_what_a_pem_holds_and_refuses_the_rest() {
        for (plain, encoded) in [
            ("f", "Zg=="),
            ("fo", "Zm8="),
            ("foo", "Zm9v"),
            ("foobar", "Zm9v\nYmFy\r\n"),
            ("fo", "Zm8"),
        ] {
            assert_eq!(
                base64_decode(encoded).unwrap(),
                plain.as_bytes(),
                "{encoded}"
            );
        }
        assert_eq!(base64_decode("+/8=").unwrap(), [0xfb, 0xff]);
        for bad in ["Z", "Zg=", "Zg==Zg", "Zm9v*", "Zm-_", "Z==="] {
            assert_eq!(base64_decode(bad), None, "{bad}");
        }
    }

    #[test]
    fn der_lengths_are_short_or_long_form() {
        assert_eq!(der_length(0), [0x00]);
        assert_eq!(der_length(127), [0x7f]);
        assert_eq!(der_length(128), [0x81, 0x80]);
        assert_eq!(der_length(255), [0x81, 0xff]);
        assert_eq!(der_length(256), [0x82, 0x01, 0x00]);
        assert_eq!(der_length(1190), [0x82, 0x04, 0xa6]);
    }

    fn pem(label: &str, der_bytes: &[u8]) -> String {
        // Padded base64, in lines, as a key file has it.
        let mut text = String::new();
        for chunk in der_bytes.chunks(3) {
            let unpadded = base64url(chunk).replace('-', "+").replace('_', "/");
            text.push_str(&format!("{unpadded:=<4}"));
        }
        let lines: Vec<&str> = text
            .as_bytes()
            .chunks(64)
            .map(|l| std::str::from_utf8(l).unwrap())
            .collect();
        format!(
            "-----BEGIN {label}-----\n{}\n-----END {label}-----\n",
            lines.join("\n")
        )
    }

    #[test]
    fn a_pkcs1_key_is_wrapped_and_a_pkcs8_key_is_passed_as_it_is() {
        // Not a real key: a DER sequence of the right kind of size, which is all the wrapper looks at.
        let mut pkcs1 = vec![0x30, 0x82, 0x01, 0x2c];
        pkcs1.extend((0..300u16).map(|i| (i % 251) as u8));
        let wrapped = pkcs8_from_pem(&pem("RSA PRIVATE KEY", &pkcs1)).unwrap();
        // SEQUENCE, its length, version 0, the RSA algorithm, then the key as an OCTET STRING.
        assert_eq!(&wrapped[..4], [0x30, 0x82, 0x01, 0x46]);
        assert_eq!(&wrapped[4..7], [0x02, 0x01, 0x00]);
        assert_eq!(
            &wrapped[7..22],
            [
                0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05,
                0x00
            ]
        );
        assert_eq!(&wrapped[22..26], [0x04, 0x82, 0x01, 0x30]);
        assert_eq!(&wrapped[26..], pkcs1.as_slice());
        assert_eq!(wrapped.len(), 4 + 0x146);
        assert_eq!(
            pkcs8_from_pem(&pem("PRIVATE KEY", &wrapped)).unwrap(),
            wrapped
        );
        // Surrounding whitespace is fine, as a secret pasted from a file has it.
        assert_eq!(
            pkcs8_from_pem(&format!("\n  {}\n", pem("RSA PRIVATE KEY", &pkcs1))).unwrap(),
            wrapped
        );
    }

    #[test]
    fn anything_that_is_not_one_private_key_is_refused() {
        let mut key = vec![0x30, 0x82, 0x01, 0x2c];
        key.extend([7u8; 300]);
        let good = pem("RSA PRIVATE KEY", &key);
        for bad in [
            String::new(),
            "not a key".to_string(),
            pem("PUBLIC KEY", &key),
            pem("EC PRIVATE KEY", &key),
            pem("CERTIFICATE", &key),
            good.replace("-----END RSA PRIVATE KEY-----", ""),
            good.replace("-----END RSA PRIVATE KEY-----", "-----END PRIVATE KEY-----"),
            format!("{good}{good}"),
            pem("RSA PRIVATE KEY", &[0x30, 0x03, 1, 2, 3]),
            pem("RSA PRIVATE KEY", &[0x04; 300]),
            good.replace('A', "*"),
        ] {
            assert_eq!(pkcs8_from_pem(&bad), None, "{}", bad.len());
        }
    }

    #[test]
    fn the_signing_input_names_the_app_and_lasts_under_ten_minutes() {
        let input = app_jwt_signing_input(5_695_065, 1_800_000_000);
        let (header, claims) = input.split_once('.').unwrap();
        assert_eq!(header, base64url(br#"{"alg":"RS256","typ":"JWT"}"#));
        assert_eq!(
            claims,
            base64url(br#"{"iat":1799999940,"exp":1800000540,"iss":"5695065"}"#)
        );
        assert!(!input.contains('=') && !input.contains('+') && !input.contains('/'));
    }

    fn role(app_id: i64, installation_id: i64, key: Option<Vec<u8>>) -> AppRole {
        AppRole {
            app_id: Some(app_id),
            installation_id: Some(installation_id),
            key,
        }
    }

    #[test]
    fn each_app_role_needs_an_app_installation_and_key_of_its_own() {
        let (mut one, mut two) = (vec![0x30, 0x82, 0x01, 0x2c], vec![0x30, 0x82, 0x01, 0x2c]);
        one.extend([1u8; 300]);
        two.extend([2u8; 300]);
        let key = |der: &[u8]| pkcs8_from_pem(&pem("RSA PRIVATE KEY", der));
        // Agent tokens: App 2 on installation 20, beside provisioning (1, 10) and merging (3, 30).
        let provisioning = role(1, 10, key(&one));
        let merging = role(3, 30, None);
        let others = [provisioning.clone(), merging.clone()];
        assert!(role_is_distinct(&role(2, 20, key(&two)), &others));
        // Another role's App, or its installation, whichever role it is, is refused.
        for clash in [
            role(1, 20, None),
            role(3, 20, None),
            role(2, 10, None),
            role(2, 30, None),
        ] {
            assert!(!role_is_distinct(&clash, &others), "{clash:?}");
        }
        // The same key, however it's written: PKCS#1 here, PKCS#8 there, other line breaks, other whitespace.
        let pkcs8 = pkcs8_from_pem(&pem("RSA PRIVATE KEY", &one)).unwrap();
        for written in [
            pem("PRIVATE KEY", &pkcs8),
            pem("RSA PRIVATE KEY", &one).replace('\n', "\r\n"),
            format!("\n\n{}  \n", pem("RSA PRIVATE KEY", &one)),
        ] {
            let same = role(2, 20, pkcs8_from_pem(&written));
            assert!(same.key.is_some());
            assert!(!role_is_distinct(&same, &others));
        }
        // A role that isn't configured collides with nothing, and neither does a part that's missing.
        assert!(role_is_distinct(
            &role(2, 20, key(&one)),
            &[AppRole::default()]
        ));
        assert!(role_is_distinct(&role(2, 20, None), &others));
    }
}
