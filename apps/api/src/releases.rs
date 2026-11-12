//! M6's routes, before any of them does anything (M6 step 2, ADR 0010).
//!
//! This step adds release's shapes and state and nothing that deploys, routes or serves. So every M6 route answers one
//! of two ways:
//!
//! - **Switched off, which is everywhere:** exactly as a path nobody ever defined. Nothing here answers it: the request
//!   goes on to where an unknown path goes, so a room's route gets whatever that room says of an unknown route to that
//!   caller (`workspace_not_found` to someone outside it, `access_revoked` to someone removed, `invalid_argument` for a
//!   body that isn't JSON, `not_found` otherwise), and any other gets the Worker's `not_found`. An M6 route can't be
//!   told from a missing one by any caller. The switch is the Worker variable `RELEASES`, on only when it is exactly
//!   `true`. No environment sets it, and setting it is the owner's yes to serving what agents wrote.
//! - **Switched on, which only a test build can be:** `release_not_available`, since nothing behind the route is built.
//!   An agent is refused first, by its kind, and an operator's route refuses anyone who isn't a configured operator, so
//!   the refusals a later step keeps are already the ones a caller meets.
//!
//! Who may configure or approve a release, and everything else about authority, is decided in `podster_policy` and
//! `podster_core` by the steps that build each route. Nothing here reads or writes state, and nothing is logged.
use crate::content_provider::Provider;
use crate::error::ApiError;
use crate::{moderation, Caller};
use podster_core::release::is_label;
use serde_json::{json, Value};
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
        ["v1", "workspaces", _, "releases", _, "approve" | "decline"] if post => {
            Some(Audience::Person)
        }
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
pub(crate) async fn switched_on(env: &Env) -> bool {
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

/// Which room a label's app belongs to, by the lookup table. It only routes the question: the room itself says whether
/// the label is its own, and acts only then.
async fn room_for_label(env: &Env, label: &str) -> R<Option<String>> {
    let found = env
        .d1("DB")?
        .prepare("SELECT workspace_id FROM app_label_index WHERE label = ?")
        .bind(&[label.into()])?
        .first::<Value>(None)
        .await?;
    Ok(found.and_then(|row| row["workspace_id"].as_str().map(str::to_owned)))
}

/// An operator suspends an app, or lifts that, by its label (M6 step 4(a)). The operator was checked before this. An
/// unknown label is `not_found`, and so is one the lookup table names for a room that says it isn't its own.
async fn app_suspension(
    env: &Env,
    caller: &Caller,
    label: &str,
    suspended: bool,
    body: Option<&str>,
) -> R<std::result::Result<Value, Response>> {
    let reason = moderation::reason_of(body)?;
    if !is_label(label) {
        return Err(ApiError::not_found());
    }
    let Some(workspace) = room_for_label(env, label).await? else {
        return Err(ApiError::not_found());
    };
    let request = json!({ "label": label, "suspended": suspended, "reason": reason.name() });
    moderation::room_action(
        env,
        &caller.id,
        &workspace,
        crate::workspace::INTERNAL_APP_SUSPENSION,
        request,
        "app",
        label,
        suspended,
        reason,
    )
    .await
}

/// The answer to an M6 route while release is switched on, which only a test build can be. An agent is refused
/// first, by its kind, and an operator's route refuses anyone who isn't a configured operator: who is asking is
/// settled before anything is said about what exists or is built.
///
/// Built (step 4(a)): an operator's suspension of an app and its lifting, by the app's label, and by its default
/// host, which is the same act. Everything else answers `release_not_available`: a custom hostname's suspension and
/// the stop for the whole content domain are the next PR's, and with no content domain configured no host is anyone's
/// default host.
pub(crate) async fn answer(
    env: &Env,
    caller: &Caller,
    audience: Audience,
    parts: &[&str],
    body: Option<&str>,
) -> R<Response> {
    if caller.kind != "person" {
        return Err(ApiError::not_allowed());
    }
    if audience == Audience::Operator {
        moderation::require_operator(env, caller)?;
    }
    let done = match parts {
        ["v1", "moderation", "apps", label, verb] => {
            app_suspension(env, caller, label, *verb == "suspend", body).await?
        }
        ["v1", "moderation", "app-hosts", host, verb] => {
            let label = Provider::from_env(env)
                .and_then(|provider| provider.default_host_label(host).map(str::to_owned));
            let Some(label) = label else {
                return Err(release_not_available());
            };
            app_suspension(env, caller, &label, *verb == "suspend", body)
                .await?
                .map(|mut answer| {
                    // Asked by the host, answered by the host. The label is the host's first part, which the
                    // operator already has.
                    if let Some(fields) = answer.as_object_mut() {
                        fields.remove("label");
                        fields.insert("host".into(), json!(host));
                    }
                    answer
                })
        }
        _ => return Err(release_not_available()),
    };
    match done {
        Ok(answer) => Ok(Response::from_json(&answer)?),
        Err(refused) => Ok(refused),
    }
}
