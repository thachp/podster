//! M6's routes, before any of them does anything (M6 step 2, ADR 0010).
//!
//! This step adds release's shapes and state and nothing that deploys, routes or serves. So every M6 route answers one
//! of two ways, decided here, before the room or any other object is asked:
//!
//! - **Switched off, which is everywhere:** as a route that doesn't exist, `not_found`, to anyone, operators included,
//!   before who is asking is looked at. The switch is the Worker variable `RELEASES`, on only when it is exactly `true`.
//!   No environment sets it, and setting it is the owner's yes to serving what agents wrote.
//! - **Switched on, which only a test build can be:** `release_not_available`, since nothing behind the route is built.
//!   An agent is refused first, by its kind, and an operator's route refuses anyone who isn't a configured operator, so
//!   the refusals a later step keeps are already the ones a caller meets.
//!
//! Who may configure or approve a release, and everything else about authority, is decided in `podster_policy` and
//! `podster_core` by the steps that build each route. Nothing here reads or writes state, and nothing is logged.
use crate::error::ApiError;
use crate::{moderation, Caller};
use worker::*;

type R<T> = std::result::Result<T, ApiError>;

/// The Worker variable that switches release on for a deployment. Set nowhere.
const SWITCH_VAR: &str = "RELEASES";

/// Who an M6 route is for.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Audience {
    /// A person: a room's own routes, and a report that names an app.
    Person,
    /// A Podster operator.
    Operator,
}

/// Whether a request is for one of M6's routes, and whose it is. The contract lists exactly these.
pub(crate) fn route(method: &Method, parts: &[&str]) -> Option<Audience> {
    let get = *method == Method::Get;
    let put = *method == Method::Put;
    let post = *method == Method::Post;
    let delete = *method == Method::Delete;
    match parts {
        ["v1", "workspaces", _, "release-config"] if get || put => Some(Audience::Person),
        ["v1", "workspaces", _, "releases", _, "approve"] if post => Some(Audience::Person),
        ["v1", "workspaces", _, "app-hostname"] if get || put || delete => Some(Audience::Person),
        ["v1", "app-reports"] if post => Some(Audience::Person),
        ["v1", "moderation", "apps", _, "suspend" | "lift"] if post => Some(Audience::Operator),
        ["v1", "moderation", "app-hosts", _, "suspend" | "lift"] if post => {
            Some(Audience::Operator)
        }
        ["v1", "moderation", "content-domain", "stop" | "resume"] if post => {
            Some(Audience::Operator)
        }
        _ => None,
    }
}

/// Whether release is switched on. A deployment reads its Worker variable alone. Test builds are also on while D1 holds
/// a table named `test_releases_on`, which a test makes and drops.
async fn switched_on(env: &Env) -> bool {
    if env
        .var(SWITCH_VAR)
        .is_ok_and(|value| value.to_string() == "true")
    {
        return true;
    }
    #[cfg(feature = "failpoints")]
    if let Ok(db) = env.d1("DB") {
        let found = db
            .prepare(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_releases_on'",
            )
            .first::<serde_json::Value>(None)
            .await;
        if matches!(found, Ok(Some(_))) {
            return true;
        }
    }
    false
}

/// The refusal of a route that exists in the contract and isn't built.
fn release_not_available() -> ApiError {
    ApiError::api(409, "release_not_available")
}

/// The answer to any M6 route: see the module's note.
pub(crate) async fn answer(env: &Env, caller: &Caller, audience: Audience) -> R<Response> {
    if !switched_on(env).await {
        return Err(ApiError::not_found());
    }
    if caller.kind != "person" {
        return Err(ApiError::not_allowed());
    }
    if audience == Audience::Operator {
        moderation::require_operator(env, caller)?;
    }
    Err(release_not_available())
}
