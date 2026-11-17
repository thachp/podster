#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Which requests reach an app (ADR 0010's revision, sections 3.4 and 3.5): methods by host kind, JSON-only writes, the
//! body's cap, the headers sent on, and the content Worker's own preflight. Each boundary both ways.

use podster_core::app_requests::*;

fn req(method: &str) -> RequestFacts<'_> {
    RequestFacts {
        method,
        content_type: None,
        content_length: None,
        service_worker: false,
        upgrade: false,
    }
}

fn write<'a>(method: &'a str, content_type: &'a str) -> RequestFacts<'a> {
    RequestFacts {
        content_type: Some(content_type),
        ..req(method)
    }
}

#[test]
fn a_static_host_takes_get_and_head_only() {
    for method in ["GET", "HEAD"] {
        assert_eq!(
            check_request(HostKind::Static, &req(method)),
            Ok(RequestClass::Read)
        );
    }
    for method in [
        "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE", "CONNECT", "get", "",
    ] {
        assert_eq!(
            check_request(HostKind::Static, &write(method, JSON_TYPE)),
            Err(RequestRefusal::MethodNotAllowed),
            "{method}"
        );
    }
    assert_eq!(allowed_methods(HostKind::Static), ["GET", "HEAD"]);
}

#[test]
fn a_code_host_also_takes_json_writes_and_its_own_preflight() {
    assert_eq!(
        check_request(HostKind::Code, &req("GET")),
        Ok(RequestClass::Read)
    );
    assert_eq!(
        check_request(HostKind::Code, &req("HEAD")),
        Ok(RequestClass::Read)
    );
    for method in WRITE_METHODS {
        assert_eq!(
            check_request(HostKind::Code, &write(method, JSON_TYPE)),
            Ok(RequestClass::Write),
            "{method}"
        );
    }
    assert_eq!(
        check_request(HostKind::Code, &req("OPTIONS")),
        Ok(RequestClass::Preflight)
    );
    assert_eq!(
        allowed_methods(HostKind::Code),
        ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]
    );
}

#[test]
fn methods_are_compared_exactly() {
    // `PATCH` is the one a browser doesn't upper-case for the page; a lower-case method reaches nothing.
    for method in [
        "patch", "Post", "delete", "put", "TRACE", "CONNECT", "PROPFIND", "options", " GET", "",
    ] {
        assert_eq!(
            check_request(HostKind::Code, &write(method, JSON_TYPE)),
            Err(RequestRefusal::MethodNotAllowed),
            "{method:?}"
        );
    }
}

#[test]
fn a_write_without_json_is_refused_before_any_app_sees_it() {
    for method in WRITE_METHODS {
        assert_eq!(
            check_request(HostKind::Code, &req(method)),
            Err(RequestRefusal::NotJson),
            "{method} with no type"
        );
        for content_type in [
            "text/plain",
            "text/plain;charset=UTF-8",
            "application/x-www-form-urlencoded",
            "multipart/form-data; boundary=x",
            "",
            "application/jsonx",
            "application/json5",
            "application/ld+json",
            "application/problem+json",
            "text/json",
            "application/json, text/plain",
            "text/plain, application/json",
            "text/plain; x=application/json",
            "application/json; charset=latin1",
            "application/json; charset=utf-8; x=y",
            "application/json; boundary=x",
            "application/json;",
            "application/ json",
        ] {
            assert_eq!(
                check_request(HostKind::Code, &write(method, content_type)),
                Err(RequestRefusal::NotJson),
                "{method} {content_type:?}"
            );
        }
    }
}

#[test]
fn json_in_its_allowed_forms() {
    for value in [
        "application/json",
        "Application/JSON",
        " application/json ",
        "application/json;charset=utf-8",
        "application/json; charset=UTF-8",
        "application/json ;\tcharset=utf-8",
        "application/json; charset=\"utf-8\"",
    ] {
        assert!(is_json_content_type(value), "{value:?}");
    }
}

#[test]
fn reads_need_no_type_and_their_body_is_never_sent_on() {
    let facts = RequestFacts {
        content_type: Some("text/plain"),
        content_length: Some("999999999"),
        ..req("GET")
    };
    assert_eq!(
        check_request(HostKind::Code, &facts),
        Ok(RequestClass::Read)
    );
    assert!(!forwarded_headers(RequestClass::Read).contains(&"content-type"));
    assert!(!forwarded_headers(RequestClass::Read).contains(&"content-length"));
}

#[test]
fn the_body_cap_at_the_boundary() {
    let at = MAX_WRITE_BODY_BYTES.to_string();
    let over = (MAX_WRITE_BODY_BYTES + 1).to_string();
    let with = |length| RequestFacts {
        content_length: Some(length),
        ..write("POST", JSON_TYPE)
    };
    assert_eq!(
        check_request(HostKind::Code, &with(&at)),
        Ok(RequestClass::Write)
    );
    assert_eq!(
        check_request(HostKind::Code, &with("0")),
        Ok(RequestClass::Write)
    );
    assert_eq!(
        check_request(HostKind::Code, &with(&over)),
        Err(RequestRefusal::TooLarge)
    );
    assert_eq!(
        check_request(HostKind::Code, &with("18446744073709551615")),
        Err(RequestRefusal::TooLarge)
    );
    assert!(body_within_cap(MAX_WRITE_BODY_BYTES));
    assert!(!body_within_cap(MAX_WRITE_BODY_BYTES + 1));
    assert!(body_within_cap(0));
    assert_eq!(MAX_WRITE_BODY_BYTES, 65_536);
}

#[test]
fn a_content_length_must_be_a_plain_number() {
    for value in [
        "",
        " 10",
        "10 ",
        "+10",
        "-1",
        "1e3",
        "0x10",
        "10, 10",
        "1.0",
        "١٠",
        "18446744073709551616",
        "000000000000000000001",
    ] {
        let facts = RequestFacts {
            content_length: Some(value),
            ..write("PUT", JSON_TYPE)
        };
        assert_eq!(
            check_request(HostKind::Code, &facts),
            Err(RequestRefusal::BadLength),
            "{value:?}"
        );
    }
    assert_eq!(parse_content_length("00000000000000000001"), Some(1));
    assert_eq!(parse_content_length("18446744073709551615"), Some(u64::MAX));
}

#[test]
fn a_write_with_no_length_passes_and_is_counted_as_it_streams() {
    assert_eq!(
        check_request(HostKind::Code, &write("PATCH", JSON_TYPE)),
        Ok(RequestClass::Write)
    );
}

#[test]
fn service_workers_and_upgrades_are_refused_on_every_host_and_method() {
    for kind in [HostKind::Static, HostKind::Code] {
        for method in ["GET", "HEAD", "POST", "OPTIONS"] {
            let sw = RequestFacts {
                service_worker: true,
                ..write(method, JSON_TYPE)
            };
            assert_eq!(check_request(kind, &sw), Err(RequestRefusal::ServiceWorker));
            let up = RequestFacts {
                upgrade: true,
                ..write(method, JSON_TYPE)
            };
            assert_eq!(check_request(kind, &up), Err(RequestRefusal::Upgrade));
        }
    }
}

#[test]
fn only_a_write_sends_the_bodys_headers_on_and_never_a_cookie() {
    assert_eq!(
        forwarded_headers(RequestClass::Read),
        ["accept", "if-none-match", "if-modified-since"]
    );
    assert_eq!(
        forwarded_headers(RequestClass::Write),
        ["accept", "content-type", "content-length"]
    );
    // A write carries no condition: a conditional write would only ever be answered 304, which isn't served.
    for name in ["if-none-match", "if-modified-since"] {
        assert!(
            !forwarded_headers(RequestClass::Write).contains(&name),
            "{name}"
        );
    }
    for class in [
        RequestClass::Read,
        RequestClass::Write,
        RequestClass::Preflight,
    ] {
        for name in [
            "cookie",
            "authorization",
            "origin",
            "upgrade",
            "service-worker",
            "host",
        ] {
            assert!(!forwarded_headers(class).contains(&name), "{name}");
        }
    }
}

#[test]
fn refusals_have_codes_and_statuses() {
    let all = [
        (RequestRefusal::MethodNotAllowed, "method_not_allowed", 405),
        (RequestRefusal::ServiceWorker, "no_service_workers", 403),
        (RequestRefusal::Upgrade, "no_upgrade", 403),
        (RequestRefusal::NotJson, "write_not_json", 415),
        (RequestRefusal::BadLength, "write_bad_length", 400),
        (RequestRefusal::TooLarge, "write_too_large", 413),
    ];
    for (refusal, code, status) in all {
        assert_eq!(refusal.code(), code);
        assert_eq!(refusal.status(), status);
    }
}

#[test]
fn a_preflight_is_allowed_for_a_code_host_with_the_origin_null() {
    let answer = PreflightAnswer {
        allow_origin: "null",
        allow_methods: "GET, HEAD, POST, PUT, PATCH, DELETE",
        allow_headers: "content-type",
    };
    for method in CODE_METHODS {
        for headers in [
            None,
            Some("content-type"),
            Some("Content-Type"),
            Some(" content-type ,"),
            Some(""),
        ] {
            assert_eq!(
                check_preflight(HostKind::Code, Some(method), headers),
                Ok(answer),
                "{method} {headers:?}"
            );
        }
    }
    assert_eq!(CODE_CACHE_CONTROL, "no-store");
}

#[test]
fn a_preflight_is_refused_otherwise() {
    assert_eq!(
        check_preflight(HostKind::Static, Some("POST"), Some("content-type")),
        Err(PreflightRefusal::NotCode)
    );
    assert_eq!(
        check_preflight(HostKind::Static, Some("GET"), None),
        Err(PreflightRefusal::NotCode)
    );
    assert_eq!(
        check_preflight(HostKind::Code, None, Some("content-type")),
        Err(PreflightRefusal::NoMethod)
    );
    for method in ["OPTIONS", "TRACE", "CONNECT", "patch", "", "POST "] {
        assert_eq!(
            check_preflight(HostKind::Code, Some(method), None),
            Err(PreflightRefusal::Method),
            "{method:?}"
        );
    }
    for headers in [
        "authorization",
        "cookie",
        "content-type,authorization",
        "x-custom",
        "content-type-x",
        "content-length",
    ] {
        assert_eq!(
            check_preflight(HostKind::Code, Some("POST"), Some(headers)),
            Err(PreflightRefusal::Header),
            "{headers}"
        );
    }
    let codes: Vec<_> = [
        PreflightRefusal::NotCode,
        PreflightRefusal::NoMethod,
        PreflightRefusal::Method,
        PreflightRefusal::Header,
    ]
    .iter()
    .map(|r| r.code())
    .collect();
    assert_eq!(
        codes,
        [
            "preflight_not_code",
            "preflight_no_method",
            "preflight_method",
            "preflight_header"
        ]
    );
}
