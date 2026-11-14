//! The room's release configuration, read and set (`getReleaseConfig`, `setReleaseConfig`; M6 step 6, ADR 0010).
//!
//! **Who and where** are `podster_policy::release::authorize_release_config` and `release_view`: a person who is the
//! room's owner or an admin, with that authority holding, and never an agent (decision 215). Switching release on needs
//! everything release needs at all ([`podster_policy::release::release_room_allows`]); switching it off is always
//! allowed to them, since it only takes down. **What it does** is `podster_core::release::release_config_change`: from
//! the version the caller read, on, off, or unchanged.
//!
//! **Switching off is ADR 0010's `release_off` trigger.** It unpublishes through `takedown::unpublish_for` in the same
//! transaction as the change, so what is up comes down with it, and the room's `fetch` then ends every release that
//! hadn't gone live, since the epoch moved. Switching on again restores nothing.
//!
//! **What is read outside, and when.** Before the transaction, as a release command reads them: whether the caller
//! still belongs to the organization their place here is held in, from their own `Principal`; and, to switch on, the
//! deployment's setting, the organization's release switch and its provisioning delegation. The deployment's setting
//! and the organization's switch are applied as they are read, as at every release command. Inside the transaction an
//! answer about anyone or anything the room's rows no longer name says nothing, and an unknown fact refuses with
//! `standing_unknown`, which writes nothing: switching on is never decided on a fact that wasn't read.
//!
//! The route exists only while the deployment's setting is on, as every M6 route; otherwise the room answers it as an
//! unknown route. Logs carry IDs and codes only.
use super::release_recheck::{settled, standing_unknown, Asked};
use super::*;
use podster_core::release::{
    release_config_change, release_switch_now, ReleaseConfigChange, UnpublishTrigger,
};
use podster_policy::release::{
    authorize_release_config, release_view, ConfigChange, ReleaseRoom, ReleaseView,
};

/// What was read outside the room before the transaction. Never taken from a request.
pub(super) struct ConfigReads {
    /// The caller's own standing: whether they still belong to the organization their place here is held in.
    caller: Asked,
    /// Only read to switch on. `None` inside when it couldn't be read.
    on: Option<OnReads>,
}

/// The facts only switching on needs.
struct OnReads {
    deployment_on: bool,
    /// The organization these were read for, so an answer about another says nothing here.
    org: String,
    provider: Option<String>,
    org_may_provision: Option<bool>,
    org_release: Option<podster_core::release::ReleaseSwitch>,
}

/// The configuration as the contract's `ReleaseConfig` gives it. A room that never set it reads as off, version 0.
pub(super) fn view(sql: &SqlStorage, domain: Option<&str>) -> R<Value> {
    let config = rows(
        sql,
        "SELECT enabled, version, set_by, updated_at FROM release_config",
        vec![],
    )?;
    let config = config.first();
    let label = rows(sql, "SELECT label FROM app_label WHERE current = 1", vec![])?
        .first()
        .and_then(|row| text(&row["label"]));
    // The default host needs the content domain; with none configured no host can be named.
    let default_host = match (label, domain) {
        (Some(label), Some(domain)) => Some(format!("{label}.{domain}")),
        _ => None,
    };
    let custom_host = rows(
        sql,
        "SELECT hostname FROM hostname_request WHERE state = 'claimed'",
        vec![],
    )?
    .first()
    .and_then(|row| text(&row["hostname"]));
    Ok(json!({
        "enabled": config.is_some_and(|c| int(&c["enabled"]) == 1),
        "approval_policy": podster_core::release::ApprovalPolicy::Person.name(),
        "environments": ["production"],
        "default_host": default_host,
        "custom_host": custom_host,
        "version": config.map_or(0, |c| int(&c["version"])),
        "set_by": config.and_then(|c| text(&c["set_by"])),
        "updated_at": config.map(|c| int(&c["updated_at"])),
    }))
}

/// `GET release-config`: for the room's owner or an admin, as a person, by the room's rows
/// (`podster_policy::release::release_view`). Nobody's `Principal` is asked for a read, since a read grants nothing.
/// Everyone else gets `not_allowed`.
pub(super) fn read(sql: &SqlStorage, who: &Participant, domain: Option<&str>) -> R<Value> {
    if release_view(&who.caller, true, false, false) != ReleaseView::Full {
        return Err(ApiError::not_allowed());
    }
    view(sql, domain)
}

/// Whether a stored answer may be replayed to the caller: only to someone who may still configure release, by the
/// room's rows now.
pub(super) fn may_configure(who: &Participant) -> R<()> {
    authorize_release_config(&who.caller, true, &ReleaseRoom::OPEN, ConfigChange::TurnOff)
        .map_err(denial)
}

/// The request's body: `{ enabled, expected_version }`, and nothing else.
fn parse(body: &Value) -> R<(bool, u64)> {
    let fields = body.as_object().ok_or_else(ApiError::invalid_argument)?;
    if fields
        .keys()
        .any(|key| key != "enabled" && key != "expected_version")
    {
        return Err(ApiError::invalid_argument());
    }
    let enabled = body["enabled"]
        .as_bool()
        .ok_or_else(ApiError::invalid_argument)?;
    let expected = body["expected_version"]
        .as_u64()
        .ok_or_else(ApiError::invalid_argument)?;
    Ok((enabled, expected))
}

/// Whether the body asks to switch release on. A body that can't be read asks nothing; the transaction refuses it.
pub(super) fn asks_on(body: &str) -> bool {
    serde_json::from_str::<Value>(body)
        .ok()
        .is_some_and(|body| body["enabled"].as_bool() == Some(true))
}

fn denial(denial: podster_policy::release::ReleaseDenial) -> ApiError {
    use podster_policy::release::ReleaseDenial as D;
    let status = match denial {
        D::NotParticipant | D::NotAllowed => 403,
        _ => 409,
    };
    // `ReleaseDenial::code` is marked reasons, since most of its codes are data elsewhere. These are what
    // `authorize_release_config` can refuse: who is asking, then `release_room_allows`'s facts. The provisioning
    // delegation is answered `release_not_delegated`, as the switch is.
    let code = denial.code();
    // error-codes: not_a_participant, not_allowed, release_off_for_deployment, organization_deleted, release_not_delegated, workspace_deleted, release_needs_public_room, workspace_archived, public_surface_suspended, app_suspended, repo_not_ready, release_off
    ApiError::api(status, code)
}

/// `PUT release-config`, in the room's transaction, after [`Workspace::release_config_reads`].
pub(super) fn handle_set(
    sql: &SqlStorage,
    who: &Participant,
    body: &Value,
    reads: &ConfigReads,
    domain: Option<&str>,
    now: i64,
) -> R<Value> {
    let caller = &who.caller;
    // Who first, by the room's rows: someone who can't configure release learns nothing of its version or of what
    // their body should be. Then the body, then whether their authority still holds, which only their own
    // `Principal` says.
    may_configure(who)?;
    let (enabled, expected_version) = parse(body)?;
    let holds =
        settled(sql, &reads.caller, Some(&caller.id), true)?.ok_or_else(standing_unknown)?;
    let config = rows(sql, "SELECT enabled, version FROM release_config", vec![])?;
    let now_config = config
        .first()
        .map(|c| (int(&c["enabled"]) == 1, int(&c["version"]).max(0) as u64));
    let change = release_config_change(now_config, enabled, expected_version)
        .map_err(|refusal| ApiError::api(409, refusal.code()))?;
    let policy_change = match (change, enabled) {
        (ReleaseConfigChange::TurnOn, _) => ConfigChange::TurnOn,
        (ReleaseConfigChange::TurnOff, _) | (ReleaseConfigChange::Unchanged, false) => {
            ConfigChange::TurnOff
        }
        (ReleaseConfigChange::Unchanged, true) => ConfigChange::Change,
    };
    let room = match policy_change {
        ConfigChange::TurnOff => ReleaseRoom::OPEN,
        ConfigChange::TurnOn | ConfigChange::Change => on_room(sql, reads)?,
    };
    authorize_release_config(caller, holds, &room, policy_change).map_err(denial)?;
    if change == ReleaseConfigChange::Unchanged {
        return view(sql, domain);
    }
    let prior = view(sql, domain)?;
    match now_config {
        None => exec(
            sql,
            "INSERT INTO release_config (singleton, enabled, version, set_by, set_at, updated_at) VALUES (1, ?, 1, ?, ?, ?)",
            vec![i64::from(enabled).into(), caller.id.as_str().into(), now.into(), now.into()],
        )?,
        Some(_) => exec(
            sql,
            "UPDATE release_config SET enabled = ?, version = version + 1, set_by = ?, set_at = ?, updated_at = ?",
            vec![i64::from(enabled).into(), caller.id.as_str().into(), now.into(), now.into()],
        )?,
    }
    let after = view(sql, domain)?;
    let record = |config: &Value| {
        json!({ "enabled": config["enabled"], "version": config["version"] }).to_string()
    };
    audit(
        sql,
        caller,
        "release.config_set",
        "release_config",
        Some(record(&prior)),
        Some(record(&after)),
        now,
    )?;
    record_event(
        sql,
        "release.config_set",
        &caller.id,
        None,
        &Transition::NONE,
        roles::room_managers(sql, &caller.id)?,
        now,
    )?;
    if change == ReleaseConfigChange::TurnOff {
        takedown::unpublish_for(sql, UnpublishTrigger::ReleaseOffInRoom, json!({}), now)?;
    }
    Ok(after)
}

/// The room as switching on sees it: its own rows now, and what was read outside, each answer counting only if it is
/// about the organization and repository the rows name now. An unread fact refuses with `standing_unknown`.
fn on_room(sql: &SqlStorage, reads: &ConfigReads) -> R<ReleaseRoom> {
    let on = reads.on.as_ref().ok_or_else(standing_unknown)?;
    let org = room_owner_org(sql)?;
    let provider = super::release_recheck::linked_provider(sql)?;
    let about_this_org = on.org == org;
    let org_may_release = release_switch_now(
        super::release_switch::applied(sql)?,
        on.org_release.filter(|_| about_this_org),
    )
    .map(|switch| switch.granted)
    .ok_or_else(standing_unknown)?;
    let org_may_provision = on
        .org_may_provision
        .filter(|_| about_this_org && on.provider == provider)
        .ok_or_else(standing_unknown)?;
    let facts = super::release_recheck::room_facts(sql, on.deployment_on, org_may_release)?;
    Ok(ReleaseRoom {
        deployment_allows_release: facts.deployment_allows_release,
        organization_may_release: facts.organization_may_release,
        organization_may_provision: org_may_provision,
        public: facts.public,
        archived: facts.archived,
        public_surface_suspended: facts.public_surface_suspended,
        app_suspended: facts.app_suspended,
        release_on_in_room: facts.release_on_in_room,
        deleted: facts.deleted,
        organization_exists: facts.organization_exists,
        repository_ready: facts.repository_ready,
    })
}

impl Workspace {
    /// Everything `PUT release-config` reads outside the room, before its transaction. Switching on also passes the
    /// release path's gate, as every release command does; switching off never waits on it, since it only takes down.
    pub(super) async fn release_config_reads(&self, caller_id: &str, body: &str) -> R<ConfigReads> {
        let sql = self.state.storage().sql();
        let on = if asks_on(body) {
            self.release_path_open().await?;
            let deployment = crate::releases::setting(&self.env).await;
            self.apply_deployment_switch(deployment).await;
            let org = room_owner_org(&sql)?;
            let provider = super::release_recheck::linked_provider(&sql)?;
            let org_may_provision = match &provider {
                Some(provider) => principal::org_delegation(&self.env, &org, provider)
                    .await
                    .ok()
                    .and_then(|answer| answer["granted"].as_bool()),
                None => Some(true),
            };
            let org_release = principal::org_release_switch(&self.env, &org).await;
            self.apply_switch_read(org_release).await;
            Some(OnReads {
                deployment_on: deployment.allows_release(),
                org,
                provider,
                org_may_provision,
                org_release,
            })
        } else {
            None
        };
        let caller = self.still_holds(Some(caller_id), true).await?;
        Ok(ConfigReads { caller, on })
    }
}
