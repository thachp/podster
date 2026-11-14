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
use crate::content_provider;
use crate::error::ApiError;
use crate::{moderation, Caller};
use podster_core::hostnames::{normalize, PODSTER_DOMAIN};
use podster_core::release::{deployment_release, is_label, DeploymentRelease};
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
        ["v1", "moderation", "takedown-findings"] if get => Some(Audience::Operator),
        // Decision 218's release switch: an operator sets it, and an operator or the organization's admin reads it, so
        // who may is `podster_policy::release`'s, in the handler.
        ["v1", "orgs", _, "release-delegation"] if get || put => Some(Audience::Person),
        _ => None,
    }
}

/// Whether an M6 route is built in the room that it names, and so goes to that room like any other room route: the room's
/// release configuration, read and set (step 6). The room answers it only while release is switched on.
pub(crate) fn room_route(parts: &[&str]) -> bool {
    matches!(parts, ["v1", "workspaces", _, "release-config"])
}

/// The deployment's release setting, `RELEASES`, read by core's one rule (`podster_core::release::deployment_release`):
/// on only for exactly `true`, off only for exactly `false`, and undecided for anything else, unset included. A
/// deployment reads its Worker variable alone. Test builds can also be switched on while D1 holds a table named
/// `test_releases_on`, or given any setting as written, while D1 holds `test_releases_setting` (`value`, null for
/// unset), which a test makes and drops.
pub(crate) async fn setting(env: &Env) -> DeploymentRelease {
    let written = env.var(SWITCH_VAR).ok().map(|value| value.to_string());
    #[cfg(feature = "failpoints")]
    if let Ok(db) = env.d1("DB") {
        if test_table(&db, "test_releases_on").await {
            return DeploymentRelease::On;
        }
        if test_table(&db, "test_releases_setting").await {
            let value = db
                .prepare("SELECT value FROM test_releases_setting LIMIT 1")
                .first::<serde_json::Value>(None)
                .await
                .ok()
                .flatten()
                .and_then(|row| row["value"].as_str().map(str::to_owned));
            return deployment_release(value.as_deref());
        }
    }
    deployment_release(written.as_deref())
}

/// Test builds only: whether D1 holds a table of this name.
#[cfg(feature = "failpoints")]
async fn test_table(db: &D1Database, name: &str) -> bool {
    let Ok(statement) = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .bind(&[name.into()])
    else {
        return false;
    };
    matches!(
        statement.first::<serde_json::Value>(None).await,
        Ok(Some(_))
    )
}

/// Whether release is switched on: the setting is exactly `true`. Off and undecided both answer no, so every M6 route
/// is answered as an unknown path and no new release or commit goes on.
pub(crate) async fn switched_on(env: &Env) -> bool {
    setting(env).await.allows_release()
}

/// The refusal of a route that exists in the contract and isn't built.
pub(crate) fn release_not_available() -> ApiError {
    ApiError::api(409, "release_not_available")
}

/// Which room a label's app belongs to, by the lookup table. It only routes the question: the room itself says whether
/// the label is its own, and acts only then.
pub(crate) async fn room_for_label(env: &Env, label: &str) -> R<Option<String>> {
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

/// An operator suspends a custom hostname, or lifts that (M6 step 4(a)). The operator was checked before this. The
/// name comes normalized, so two spellings are one name. Anything on the content domain that isn't an app's
/// default host, and anything on Podster's own domain, is nobody's hostname: `not_found`. The suspension is the
/// hostname's own object's, with no room, so it holds whether or not any room has ever asked for the name.
async fn hostname_suspension(
    env: &Env,
    caller: &Caller,
    domain: &str,
    name: &str,
    suspended: bool,
    body: Option<&str>,
) -> R<std::result::Result<Value, Response>> {
    let reason = moderation::reason_of(body)?;
    if !name.contains('.') {
        return Err(ApiError::invalid_argument());
    }
    if content_provider::on_domain(domain, name)
        || content_provider::on_domain(PODSTER_DOMAIN, name)
    {
        return Err(ApiError::not_found());
    }
    let stub = env
        .durable_object("HOSTNAME_CLAIM")?
        .id_from_name(name)?
        .get_stub()?;
    let request = json!({ "hostname": name, "suspended": suspended, "reason": reason.name() });
    let done = moderation::object_action(
        env,
        &caller.id,
        stub,
        crate::hostname_claim::INTERNAL_SUSPENSION,
        request,
        "app_host",
        name,
        suspended,
        reason,
    )
    .await?;
    Ok(done.map(|mut answer| {
        if let Some(fields) = answer.as_object_mut() {
            fields.insert("host".into(), json!(name));
        }
        answer
    }))
}

/// An operator stops the whole content domain, or resumes it (M6 step 4(a)). The operator was checked before this.
/// The stop's home is the `Moderation` object, which also keeps the record of who did it.
async fn content_stop(
    env: &Env,
    caller: &Caller,
    stopped: bool,
    body: Option<&str>,
) -> R<std::result::Result<Value, Response>> {
    let reason = moderation::reason_of(body)?;
    let request = json!({ "stopped": stopped, "reason": reason.name() });
    moderation::object_action(
        env,
        &caller.id,
        moderation::moderation(env)?,
        crate::content_stop::PATH,
        request,
        "content_domain",
        "content_domain",
        stopped,
        reason,
    )
    .await
}

/// The answer to an M6 route while release is switched on, which only a test build can be. An agent is refused
/// first, by its kind, and an operator's route refuses anyone who isn't a configured operator: who is asking is
/// settled before anything is said about what exists or is built.
///
/// Built (step 4(a)): an operator's suspension of an app and its lifting, by the app's label and by its default
/// host, which is the same act; a custom hostname's suspension and its lifting; and the stop for the whole content
/// domain and its lifting; and the operator's read of what the reconciles found. Built (step 9): a person's report that
/// names an app by its address. Built (decision 218, PR B): an organization's release switch, read and set. Built (step 6), and answered by the room
/// itself, not here ([`room_route`]): the room's release configuration, read and set. Everything else answers `release_not_available`, and so does a host's route while no
/// content domain is configured, since no host can then be told from another.
pub(crate) async fn answer(
    env: &Env,
    caller: &Caller,
    audience: Audience,
    parts: &[&str],
    body: Option<&str>,
    req: &Request,
) -> R<Response> {
    if caller.kind != "person" {
        return Err(ApiError::not_allowed());
    }
    if audience == Audience::Operator {
        moderation::require_operator(env, caller)?;
    }
    let done = match parts {
        // A report that names an app by its address (step 9). It needs no content domain: any well-formed host is kept,
        // and nothing says whether it is served.
        ["v1", "app-reports"] => return moderation::app_report(env, caller, body, req).await,
        ["v1", "moderation", "apps", label, verb] => {
            app_suspension(env, caller, label, *verb == "suspend", body).await?
        }
        ["v1", "moderation", "app-hosts", host, verb] => {
            // Telling an app's default host from a custom hostname needs the content domain. With none configured,
            // which is every deployment, no host can be placed, and nothing is done for any.
            let Some(domain) = content_provider::content_domain(env) else {
                return Err(release_not_available());
            };
            let suspended = *verb == "suspend";
            // The name as Podster writes it, so two spellings of a host are one host.
            let name = normalize(host).map_err(|_| ApiError::invalid_argument())?;
            match content_provider::default_host_label_on(&domain, &name) {
                Some(label) => app_suspension(env, caller, label, suspended, body)
                    .await?
                    .map(|mut answer| {
                        // Asked by the host, answered by the host. The label is the host's first part, which the
                        // operator already has.
                        if let Some(fields) = answer.as_object_mut() {
                            fields.remove("label");
                            fields.insert("host".into(), json!(name));
                        }
                        answer
                    }),
                None => hostname_suspension(env, caller, &domain, &name, suspended, body).await?,
            }
        }
        ["v1", "moderation", "content-domain", verb] => {
            content_stop(env, caller, *verb == "stop", body).await?
        }
        // The operator's release switch for an organization (decision 218, PR B).
        ["v1", "orgs", org, "release-delegation"] => {
            let set = (req.method() == Method::Put).then_some(body.unwrap_or(""));
            return crate::principal::release_delegation(env, caller, org, set).await;
        }
        // What the reconciles and the rooms found that needs an operator (third PR). A read: nothing is recorded.
        ["v1", "moderation", "takedown-findings"] => {
            return moderation::call(env, crate::reconcile::FINDINGS_PATH, Method::Get, None).await;
        }
        _ => return Err(release_not_available()),
    };
    match done {
        Ok(answer) => Ok(Response::from_json(&answer)?),
        Err(refused) => Ok(refused),
    }
}
