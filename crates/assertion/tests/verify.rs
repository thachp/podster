#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
use ed25519_dalek::{Signer, SigningKey};
use podster_assertion::*;
use serde_json::{json, Value};

const NOW: i64 = 1_800_000_000;

fn key(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}

fn keys() -> KeySet {
    let public = B64.encode(key(1).verifying_key().to_bytes());
    KeySet::from_json(&json!({ "k1": public }).to_string()).unwrap()
}

fn claims() -> Value {
    json!({ "iss": ISSUER, "aud": AUDIENCE, "sub": "agt_1", "kind": "agent", "org": "org_1", "gen": 3, "jti": "j1", "iat": NOW, "exp": NOW + 60 })
}

fn sign_raw(header: &Value, claims: &Value, signer: &SigningKey) -> String {
    let body = format!(
        "{}.{}",
        B64.encode(header.to_string()),
        B64.encode(claims.to_string())
    );
    format!(
        "{body}.{}",
        B64.encode(signer.sign(body.as_bytes()).to_bytes())
    )
}

fn sign(claims: &Value) -> String {
    sign_raw(&json!({ "alg": "EdDSA", "kid": "k1" }), claims, &key(1))
}

fn with(field: &str, value: Value) -> Value {
    let mut c = claims();
    c[field] = value;
    c
}

#[test]
fn accepts_a_valid_assertion() {
    let identity = verify(&sign(&claims()), &keys(), NOW).unwrap();
    assert_eq!(
        (
            identity.sub.as_str(),
            identity.kind,
            identity.org.as_str(),
            identity.gen
        ),
        ("agt_1", Kind::Agent, "org_1", Some(3))
    );
}

#[test]
fn rejects_forgeries() {
    let header = json!({ "alg": "EdDSA", "kid": "k1" });
    assert_eq!(
        verify(&sign_raw(&header, &claims(), &key(2)), &keys(), NOW),
        Err(AssertionError::BadSignature)
    );
    assert_eq!(
        verify(
            &sign_raw(
                &json!({ "alg": "EdDSA", "kid": "other" }),
                &claims(),
                &key(1)
            ),
            &keys(),
            NOW
        ),
        Err(AssertionError::UnknownKey)
    );
    assert_eq!(
        verify(
            &sign_raw(&json!({ "alg": "EdDSA" }), &claims(), &key(1)),
            &keys(),
            NOW
        ),
        Err(AssertionError::UnknownKey)
    );
    assert_eq!(
        verify(
            &sign_raw(&json!({ "alg": "none", "kid": "k1" }), &claims(), &key(1)),
            &keys(),
            NOW
        ),
        Err(AssertionError::UnsupportedAlgorithm)
    );
    assert_eq!(
        verify(
            &sign_raw(&json!({ "alg": "HS256", "kid": "k1" }), &claims(), &key(1)),
            &keys(),
            NOW
        ),
        Err(AssertionError::UnsupportedAlgorithm)
    );
}

#[test]
fn rejects_an_edited_payload() {
    let token = sign(&claims());
    let parts: Vec<&str> = token.split('.').collect();
    let edited = format!(
        "{}.{}.{}",
        parts[0],
        B64.encode(with("sub", json!("agt_admin")).to_string()),
        parts[2]
    );
    assert_eq!(
        verify(&edited, &keys(), NOW),
        Err(AssertionError::BadSignature)
    );
}

#[test]
fn rejects_bad_claims() {
    assert_eq!(
        verify(&sign(&with("aud", json!("other"))), &keys(), NOW),
        Err(AssertionError::WrongAudience)
    );
    assert_eq!(
        verify(&sign(&with("exp", json!(NOW + 61))), &keys(), NOW),
        Err(AssertionError::LifetimeTooLong)
    );
    assert_eq!(
        verify(&sign(&with("kind", json!("admin"))), &keys(), NOW),
        Err(AssertionError::Malformed)
    );
    assert_eq!(
        verify(&sign(&with("sub", json!(""))), &keys(), NOW),
        Err(AssertionError::Malformed)
    );
    assert_eq!(
        verify(&sign(&claims()), &keys(), NOW + 60 + CLOCK_SKEW_SECS),
        Err(AssertionError::Expired)
    );
    assert!(verify(&sign(&claims()), &keys(), NOW + 60 + CLOCK_SKEW_SECS - 1).is_ok());
    assert_eq!(
        verify(&sign(&claims()), &keys(), NOW - CLOCK_SKEW_SECS - 1),
        Err(AssertionError::NotYetValid)
    );
}

#[test]
fn rejects_missing_issuer_and_bad_shapes() {
    assert_eq!(
        verify(&sign(&with("iss", json!("someone"))), &keys(), NOW),
        Err(AssertionError::WrongIssuer)
    );
    let mut no_iss = claims();
    no_iss.as_object_mut().unwrap().remove("iss");
    assert_eq!(
        verify(&sign(&no_iss), &keys(), NOW),
        Err(AssertionError::WrongIssuer)
    );
    assert_eq!(
        verify(&sign(&with("exp", json!(NOW))), &keys(), NOW),
        Err(AssertionError::Malformed)
    );
    let mut no_gen = claims();
    no_gen.as_object_mut().unwrap().remove("gen");
    assert_eq!(
        verify(&sign(&no_gen), &keys(), NOW),
        Err(AssertionError::Malformed)
    );
    let mut person = with("kind", json!("person"));
    person.as_object_mut().unwrap().remove("gen");
    assert!(verify(&sign(&person), &keys(), NOW).is_ok());
    let null_crit = json!({ "alg": "EdDSA", "kid": "k1", "crit": null });
    assert_eq!(
        verify(&sign_raw(&null_crit, &claims(), &key(1)), &keys(), NOW),
        Err(AssertionError::UnsupportedAlgorithm)
    );
    let crit = json!({ "alg": "EdDSA", "kid": "k1", "crit": ["x"], "x": 1 });
    assert_eq!(
        verify(&sign_raw(&crit, &claims(), &key(1)), &keys(), NOW),
        Err(AssertionError::UnsupportedAlgorithm)
    );
}

#[test]
fn rejects_malformed_input() {
    for token in ["", "a", "a.b", "a.b.c", "a.b.c.d", "!!.!!.!!"] {
        assert!(verify(token, &keys(), NOW).is_err(), "{token}");
    }
    assert!(KeySet::from_json("not json").is_err());
    assert!(KeySet::from_json(r#"{"k":"short"}"#).is_err());
}

#[test]
fn a_target_member_claim_is_read_and_is_optional() {
    let without = verify(&sign(&claims()), &keys(), NOW).unwrap();
    assert_eq!(without.target_member, None);
    let mut body = claims();
    body["target_member"] = json!({ "person": "per_x", "orgs": { "org_y": 5 } });
    body["org_since"] = json!({ "org_y": 7 });
    let with = verify(&sign(&body), &keys(), NOW).unwrap();
    assert_eq!(
        with.target_member,
        Some(TargetMember {
            person: "per_x".into(),
            orgs: [("org_y".to_string(), 5)].into()
        })
    );
    assert_eq!(with.org_since.get("org_y"), Some(&7));
    assert_eq!(with.departure, None);
    body["departure"] = json!({ "person": "per_x", "org": "org_y", "left_at": 9 });
    let leaving = verify(&sign(&body), &keys(), NOW).unwrap();
    assert_eq!(
        leaving.departure,
        Some(Departure {
            person: "per_x".into(),
            org: "org_y".into(),
            left_at: 9
        })
    );
}

fn public_claims() -> Value {
    json!({ "iss": ISSUER, "aud": AUDIENCE, "kind": "public", "jti": "p1", "iat": NOW, "exp": NOW + 60 })
}

#[test]
fn only_the_room_page_takes_a_public_assertion() {
    let token = sign(&public_claims());
    // Every other route verifies with `verify`, which refuses it.
    assert_eq!(verify(&token, &keys(), NOW), Err(AssertionError::Malformed));
    match verify_room_page_caller(&token, &keys(), NOW).unwrap() {
        RoomPageCaller::Public(public) => assert_eq!(public.jti, "p1"),
        RoomPageCaller::SignedIn(_) => panic!("read as signed in"),
    }
    // A signed-in caller still reads as one.
    assert!(matches!(
        verify_room_page_caller(&sign(&claims()), &keys(), NOW).unwrap(),
        RoomPageCaller::SignedIn(identity) if identity.sub == "agt_1"
    ));
}

#[test]
fn a_public_assertion_names_no_one() {
    for (field, value) in [
        ("sub", json!("per_1")),
        ("org", json!("org_1")),
        ("gen", json!(1)),
        ("orgs", json!(["org_1"])),
        ("admin_orgs", json!(["org_1"])),
        ("target_member", json!({ "person": "per_1", "orgs": {} })),
        ("linker", json!({ "person": "per_1", "since": 1 })),
        ("anything", json!(true)),
    ] {
        let mut c = public_claims();
        c[field] = value;
        assert_eq!(
            verify_room_page_caller(&sign(&c), &keys(), NOW),
            Err(AssertionError::Malformed),
            "{field}"
        );
    }
}

#[test]
fn a_public_assertion_is_checked_like_any_other() {
    let mut expired = public_claims();
    expired["exp"] = json!(NOW - 10);
    expired["iat"] = json!(NOW - 20);
    assert_eq!(
        verify_room_page_caller(&sign(&expired), &keys(), NOW),
        Err(AssertionError::Expired)
    );
    let mut long = public_claims();
    long["exp"] = json!(NOW + 600);
    assert_eq!(
        verify_room_page_caller(&sign(&long), &keys(), NOW),
        Err(AssertionError::LifetimeTooLong)
    );
    let mut audience = public_claims();
    audience["aud"] = json!("elsewhere");
    assert_eq!(
        verify_room_page_caller(&sign(&audience), &keys(), NOW),
        Err(AssertionError::WrongAudience)
    );
    let forged = sign_raw(
        &json!({ "alg": "EdDSA", "kid": "k1" }),
        &public_claims(),
        &key(2),
    );
    assert_eq!(
        verify_room_page_caller(&forged, &keys(), NOW),
        Err(AssertionError::BadSignature)
    );
    let mut empty = public_claims();
    empty["jti"] = json!("");
    assert_eq!(
        verify_room_page_caller(&sign(&empty), &keys(), NOW),
        Err(AssertionError::Malformed)
    );
}

fn delivery_claims() -> Value {
    json!({ "iss": ISSUER, "aud": AUDIENCE, "kind": "provider_delivery", "provider": "github", "delivery": "d-1",
        "body_sha256": "ab".repeat(32), "jti": "w1", "iat": NOW, "exp": NOW + 60 })
}

#[test]
fn only_the_delivery_route_takes_a_provider_delivery() {
    let token = sign(&delivery_claims());
    let delivery = podster_assertion::verify_provider_delivery(&token, &keys(), NOW).unwrap();
    assert_eq!(delivery.provider, "github");
    assert_eq!(delivery.delivery, "d-1");
    assert_eq!(delivery.body_sha256, "ab".repeat(32));
    // It names no one, so no route that needs an identity takes it, and the room page doesn't either.
    assert_eq!(verify(&token, &keys(), NOW), Err(AssertionError::Malformed));
    assert!(matches!(
        verify_room_page_caller(&token, &keys(), NOW),
        Err(AssertionError::Malformed)
    ));
    // And the delivery route takes nothing else: not an identity, and not the public assertion.
    for other in [claims(), public_claims()] {
        assert_eq!(
            podster_assertion::verify_provider_delivery(&sign(&other), &keys(), NOW),
            Err(AssertionError::Malformed)
        );
    }
}

#[test]
fn a_provider_delivery_is_checked_like_any_other() {
    let check = |c: &Value| podster_assertion::verify_provider_delivery(&sign(c), &keys(), NOW);
    let set = |field: &str, value: Value| {
        let mut c = delivery_claims();
        c[field] = value;
        c
    };
    assert_eq!(
        check(&set("exp", json!(NOW - 10))),
        Err(AssertionError::Malformed)
    );
    let mut expired = delivery_claims();
    expired["iat"] = json!(NOW - 100);
    expired["exp"] = json!(NOW - 40);
    assert_eq!(check(&expired), Err(AssertionError::Expired));
    assert_eq!(
        check(&set("exp", json!(NOW + 600))),
        Err(AssertionError::LifetimeTooLong)
    );
    assert_eq!(
        check(&set("aud", json!("someone-else"))),
        Err(AssertionError::WrongAudience)
    );
    assert_eq!(
        check(&set("iss", json!("someone-else"))),
        Err(AssertionError::WrongIssuer)
    );
    // A body hash that isn't 64 lowercase hex digits, an empty field, a missing field and an extra one are all malformed.
    for (field, value) in [
        ("body_sha256", json!("AB".repeat(32))),
        ("body_sha256", json!("ab".repeat(31))),
        ("body_sha256", json!("zz".repeat(32))),
        ("delivery", json!("")),
        ("provider", json!("")),
        ("jti", json!("")),
        ("sub", json!("per_1")),
        ("org", json!("org_1")),
    ] {
        assert_eq!(
            check(&set(field, value)),
            Err(AssertionError::Malformed),
            "{field}"
        );
    }
    for field in ["provider", "delivery", "body_sha256", "jti", "kind"] {
        let mut c = delivery_claims();
        c.as_object_mut().unwrap().remove(field);
        assert_eq!(check(&c), Err(AssertionError::Malformed), "{field}");
    }
    // Signed by a key the API doesn't hold.
    let header = json!({ "alg": "EdDSA", "kid": "k1" });
    let forged = sign_raw(&header, &delivery_claims(), &key(2));
    assert_eq!(
        podster_assertion::verify_provider_delivery(&forged, &keys(), NOW),
        Err(AssertionError::BadSignature)
    );
}
