//! Which requests the content Worker lets through to an app, by whether the host's release carries code (ADR 0010's
//! proposed revision, sections 3.4 and 3.5, decided by the owner on 2026-11-13 as decision 220, answer 5). Pure, with
//! no I/O, and not wired into the content Worker yet.
//!
//! - **A static app** keeps what the content Worker does today: `GET` and `HEAD`, three request headers, no body.
//! - **An app whose release has code** also takes `POST`, `PUT`, `PATCH` and `DELETE`, each only with a JSON
//!   `Content-Type` ([`is_json_content_type`]), so that every write a browser sends has first asked leave in a
//!   preflight. The content Worker answers that preflight itself ([`check_preflight`]), allowing the origin `null`,
//!   and an app never sees an `OPTIONS` request.
//! - **Refused for every app:** a request that asks for a WebSocket, and a request for a service worker's script.

/// What a host serves, from its serve entry.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HostKind {
    /// Static files only.
    Static,
    /// A release that carries code.
    Code,
}

/// What a request let through is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RequestClass {
    /// `GET` or `HEAD`, which pass with no body.
    Read,
    /// `POST`, `PUT`, `PATCH` or `DELETE` to a host with code, with a JSON body within the cap. Counted against the
    /// app's write budget ([`crate::write_budget`]).
    Write,
    /// `OPTIONS` to a host with code: answered by the content Worker itself ([`check_preflight`]), never sent on.
    Preflight,
}

/// The largest body a write may carry, in bytes. **Proposed:** the revision gives 64 KiB as a guess.
pub const MAX_WRITE_BODY_BYTES: u64 = 64 * 1024;
/// The methods a static app takes.
pub const STATIC_METHODS: [&str; 2] = ["GET", "HEAD"];
/// The methods an app with code takes, besides the preflight the content Worker answers.
pub const CODE_METHODS: [&str; 6] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];
/// The methods that write.
pub const WRITE_METHODS: [&str; 4] = ["POST", "PUT", "PATCH", "DELETE"];
/// The visitor's headers sent on to an app with every request, as today.
pub const READ_HEADERS: [&str; 3] = ["accept", "if-none-match", "if-modified-since"];
/// The visitor's headers sent on to an app with a write: `Accept`, and the body's type and length. A read's two
/// conditions don't pass: a conditional write could only ever be answered `304`, which isn't served. `Cookie`,
/// `Authorization` and every other header never pass.
pub const WRITE_HEADERS: [&str; 3] = ["accept", "content-type", "content-length"];
/// The only media type a write may carry.
pub const JSON_TYPE: &str = "application/json";
/// The `Access-Control-Allow-Origin` of every answer for a host with code, the preflight's among them: the origin a
/// sandboxed page has. It keeps out a page that hasn't sandboxed itself, and is no boundary against one that has.
pub const CODE_ALLOW_ORIGIN: &str = "null";
/// The preflight's `Access-Control-Allow-Methods`.
pub const CODE_ALLOW_METHODS: &str = "GET, HEAD, POST, PUT, PATCH, DELETE";
/// The preflight's `Access-Control-Allow-Headers`: the only request header a page may ask leave to send.
pub const CODE_ALLOW_HEADERS: &str = "content-type";
/// The `Cache-Control` of every answer of an app with code. The content Worker can't tell a static file's answer from
/// the script's, and `no-store` is never wrong.
pub const CODE_CACHE_CONTROL: &str = "no-store";

/// The facts of a request the rule needs, as the content Worker read them. A header that wasn't sent is `None`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RequestFacts<'a> {
    pub method: &'a str,
    pub content_type: Option<&'a str>,
    pub content_length: Option<&'a str>,
    /// Whether a `Service-Worker` header was sent, whatever it holds.
    pub service_worker: bool,
    /// Whether an `Upgrade` header was sent, whatever it holds.
    pub upgrade: bool,
}

/// Why a request is refused by the content Worker before it reaches an app.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RequestRefusal {
    /// `method_not_allowed`: a method this host doesn't take. Methods are compared exactly, in upper case.
    MethodNotAllowed,
    /// `no_service_workers`
    ServiceWorker,
    /// `no_upgrade`: a WebSocket, or any other upgrade.
    Upgrade,
    /// `write_not_json`: a write whose `Content-Type` isn't JSON, or is missing.
    NotJson,
    /// `write_bad_length`: a `Content-Length` that isn't a plain decimal number.
    BadLength,
    /// `write_too_large`: a declared or counted body over [`MAX_WRITE_BODY_BYTES`].
    TooLarge,
}

impl RequestRefusal {
    // codes: reasons
    pub fn code(self) -> &'static str {
        match self {
            RequestRefusal::MethodNotAllowed => "method_not_allowed",
            RequestRefusal::ServiceWorker => "no_service_workers",
            RequestRefusal::Upgrade => "no_upgrade",
            RequestRefusal::NotJson => "write_not_json",
            RequestRefusal::BadLength => "write_bad_length",
            RequestRefusal::TooLarge => "write_too_large",
        }
    }

    /// The status the content Worker answers with.
    pub fn status(self) -> u16 {
        match self {
            RequestRefusal::MethodNotAllowed => 405,
            RequestRefusal::ServiceWorker | RequestRefusal::Upgrade => 403,
            RequestRefusal::NotJson => 415,
            RequestRefusal::BadLength => 400,
            RequestRefusal::TooLarge => 413,
        }
    }
}

/// The methods a host takes, for its `Allow` header.
pub fn allowed_methods(kind: HostKind) -> &'static [&'static str] {
    match kind {
        HostKind::Static => &STATIC_METHODS,
        HostKind::Code => &CODE_METHODS,
    }
}

/// The visitor's headers sent on to an app with a request of this class.
pub fn forwarded_headers(class: RequestClass) -> &'static [&'static str] {
    match class {
        RequestClass::Write => &WRITE_HEADERS,
        RequestClass::Read | RequestClass::Preflight => &READ_HEADERS,
    }
}

/// Whether a `Content-Type` is JSON: the media type `application/json`, in any case, with at most one parameter,
/// `charset=utf-8`. A browser never sends either form without a preflight, which is the point: a type a browser may send
/// without one (`text/plain` among them) is never a write.
pub fn is_json_content_type(value: &str) -> bool {
    let mut parts = value.split(';');
    let essence = parts.next().unwrap_or("").trim_matches([' ', '\t']);
    if !essence.eq_ignore_ascii_case(JSON_TYPE) {
        return false;
    }
    match (parts.next(), parts.next()) {
        (None, _) => true,
        (Some(parameter), None) => {
            let parameter = parameter.trim_matches([' ', '\t']);
            parameter.eq_ignore_ascii_case("charset=utf-8")
                || parameter.eq_ignore_ascii_case("charset=\"utf-8\"")
        }
        _ => false,
    }
}

/// A `Content-Length`, read strictly: one to twenty ASCII digits and nothing else, no sign, no space, no list.
pub fn parse_content_length(value: &str) -> Option<u64> {
    if value.is_empty() || value.len() > 20 || !value.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    value.parse().ok()
}

/// Whether a body counted so far, in bytes, is still within the cap. The content Worker counts a body that came with
/// no `Content-Length`, and stops it at the first byte over.
pub fn body_within_cap(bytes: u64) -> bool {
    bytes <= MAX_WRITE_BODY_BYTES
}

/// Whether a request may pass to an app on a host of this kind, and as what.
pub fn check_request(kind: HostKind, facts: &RequestFacts) -> Result<RequestClass, RequestRefusal> {
    if facts.service_worker {
        return Err(RequestRefusal::ServiceWorker);
    }
    if facts.upgrade {
        return Err(RequestRefusal::Upgrade);
    }
    let method = facts.method;
    if STATIC_METHODS.contains(&method) {
        return Ok(RequestClass::Read);
    }
    if kind == HostKind::Static {
        return Err(RequestRefusal::MethodNotAllowed);
    }
    if method == "OPTIONS" {
        return Ok(RequestClass::Preflight);
    }
    if !WRITE_METHODS.contains(&method) {
        return Err(RequestRefusal::MethodNotAllowed);
    }
    if !facts.content_type.is_some_and(is_json_content_type) {
        return Err(RequestRefusal::NotJson);
    }
    if let Some(length) = facts.content_length {
        let length = parse_content_length(length).ok_or(RequestRefusal::BadLength)?;
        if !body_within_cap(length) {
            return Err(RequestRefusal::TooLarge);
        }
    }
    Ok(RequestClass::Write)
}

/// Why a preflight isn't allowed. The content Worker answers it itself, with no `Access-Control-Allow-*` header, so
/// the browser sends nothing further.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PreflightRefusal {
    /// `preflight_not_code`: the host's release has no code. Answered as any `OPTIONS` to it is, today.
    NotCode,
    /// `preflight_no_method`: no `Access-Control-Request-Method`, so it isn't a preflight.
    NoMethod,
    /// `preflight_method`: a method the host doesn't take.
    Method,
    /// `preflight_header`: a header other than `Content-Type`.
    Header,
}

impl PreflightRefusal {
    // codes: reasons
    pub fn code(self) -> &'static str {
        match self {
            PreflightRefusal::NotCode => "preflight_not_code",
            PreflightRefusal::NoMethod => "preflight_no_method",
            PreflightRefusal::Method => "preflight_method",
            PreflightRefusal::Header => "preflight_header",
        }
    }
}

/// What the content Worker's answer to an allowed preflight carries: [`CODE_ALLOW_ORIGIN`], [`CODE_ALLOW_METHODS`]
/// and [`CODE_ALLOW_HEADERS`], fixed, whatever was asked.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PreflightAnswer {
    pub allow_origin: &'static str,
    pub allow_methods: &'static str,
    pub allow_headers: &'static str,
}

/// Whether to allow a preflight, from its `Access-Control-Request-Method` and `Access-Control-Request-Headers`. The
/// `Origin` isn't read: every sandboxed page's is `null`, and the answer is the same for all.
pub fn check_preflight(
    kind: HostKind,
    request_method: Option<&str>,
    request_headers: Option<&str>,
) -> Result<PreflightAnswer, PreflightRefusal> {
    if kind != HostKind::Code {
        return Err(PreflightRefusal::NotCode);
    }
    let method = request_method.ok_or(PreflightRefusal::NoMethod)?;
    if !CODE_METHODS.contains(&method) {
        return Err(PreflightRefusal::Method);
    }
    if let Some(headers) = request_headers {
        for name in headers.split(',') {
            let name = name.trim_matches([' ', '\t']);
            if !name.is_empty() && !name.eq_ignore_ascii_case(CODE_ALLOW_HEADERS) {
                return Err(PreflightRefusal::Header);
            }
        }
    }
    Ok(PreflightAnswer {
        allow_origin: CODE_ALLOW_ORIGIN,
        allow_methods: CODE_ALLOW_METHODS,
        allow_headers: CODE_ALLOW_HEADERS,
    })
}
