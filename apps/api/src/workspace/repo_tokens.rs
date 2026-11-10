//! `get_repo_access`: a short-lived token for the room's one repository, for the agent a task is assigned to (M5 step 6,
//! ADR 0009, which is proposed). The rest of the room never sees one.
//!
//! **Authority.** `podster_policy::repositories::authorize_repo_access` runs first, so a task the caller can't see answers
//! as one that doesn't exist. Then `podster_core::repo_access::decide_access`, on the room's current rows and two answers
//! from `Principal`s: whether the room's owner still holds the repository's delegation, and whether the person who linked
//! the agent's credential is still in its organization. A grant counts only while its giver is that holder, read from
//! current authority, never from the grant list's display `state`. Nothing about the organization, the installation or
//! the repository comes from the caller, who names only the task.
//!
//! **The token.** It's minted through [`TokenIssuer`] with the agent-token App, narrowed to the link's repository ID and
//! `TokenPermissions::AGENT`, and checked with `minted_token_matches` before anyone sees it. Anything else is revoked and
//! refused. The room keeps it sealed under `REPO_TOKEN_KEY`, with the room, repository, grant, agent and task bound as
//! associated data, for at most its hour and only so it can be revoked. It never goes into an event, a log, D1, the
//! outbox, the idempotency store or an error, and the gateway only passes the answer through.
//!
//! **No idempotency record.** A stored answer would be a second copy of the token. The command is idempotent by
//! coalescing instead: one live token per agent and task, a repeat call gets the held one until 5 minutes before it
//! expires, and then a new one replaces it and the old one is revoked.
//!
//! **Order: decide, lease, mint, commit.** The first transaction decides and takes a lease row. The unique index on a
//! lease per agent and task means a concurrent call sees it and is refused `repo_access_busy`, so two mints can't
//! happen. Then the mint, outside any transaction. The second transaction decides again on current state, checks the
//! lease is still this call's, and commits the sealed token, the replaced one's revocation and the event together. If it
//! refuses or fails, the minted token is revoked at once, and if that fails it's queued for the alarm. A Worker that dies
//! between the mint and the commit leaves a token nobody holds, which lives out its hour: the one acknowledged gap.
//!
//! **Revocation.** Each cascade that ends a token's authority marks it in its own transaction, through
//! `store::mark_stale_repo_tokens`. The alarm revokes marked tokens with `DELETE /installation/token`, retrying with
//! backoff until the token would have expired anyway, and removes the rows. A failed revoke never holds up the cascade.
use super::*;
use crate::github::{AgentConfig, AgentTokens, Minted, Revoked, TokenIssuer};
use podster_core::repo_access::{
    decide_access, minted_token_matches, AccessCheck, AccessRefusal, Budget, Deadline, HeldToken,
    TokenPermissions, TokenPlan,
};
use podster_core::repo_grants::Grant;
use podster_core::repositories::{GrantAction, LinkStatus, RequestState};
use podster_egress::endpoint::{open_labeled, parse_key, seal_labeled};
use podster_policy::repositories::{authorize_repo_access, delegation_holder, GrantStanding};

/// The Worker secret holding the sealing key, 64 hex characters. The owner sets it. Unset, nothing is minted.
pub(super) const KEY_SECRET: &str = "REPO_TOKEN_KEY";
/// **Proposed:** mints an agent may cause in a room in an hour, renewals included. A token lives an hour and is renewed
/// after 55 minutes, so an agent on one task needs about one an hour, and a handful of tasks fit well inside this.
pub(super) const MINTS_PER_AGENT_HOUR: i64 = 10;
/// **Proposed:** mints a room may cause in an hour. The agent-token App's installation has 5,000 requests an hour for
/// the whole organization, and every room shares them.
pub(super) const MINTS_PER_ROOM_HOUR: i64 = 60;
const HOUR_MS: i64 = 3_600_000;
/// How long a lease holds: longer than signing the App's JWT and one call to GitHub, which times out in 10 seconds.
const LEASE_MS: i64 = 30_000;
const REVOKE_FIRST_WAIT_MS: i64 = 60_000;
const REVOKE_LONGEST_WAIT_MS: i64 = 15 * 60_000;
/// Revocations one alarm attempts, so a room with many doesn't run long.
const REVOKES_PER_ALARM: i64 = 10;
/// A token GitHub says lives longer than this isn't what the agent-token App mints, and is refused.
const LONGEST_LIFE_MS: i64 = HOUR_MS + 60_000;

fn unavailable() -> ApiError {
    ApiError::api(503, "repo_access_unavailable")
}

fn busy() -> ApiError {
    ApiError::api(409, "repo_access_busy")
}

/// The associated data a token is sealed under. A sealed copy opens only for the same room, repository, grant, agent
/// and task, so a row moved to another can't be opened there.
fn label(room: &str, repo: i64, grant: &str, agent: &str, task: &str) -> String {
    format!("repo-token:{room}:{repo}:{grant}:{agent}:{task}")
}

/// The sealing key, if it's set and well-formed. Its value is never logged. Test builds can make one room see it
/// unset, by a table only a test can make, as a deployment before the owner sets it would.
fn key(env: &Env, sql: &SqlStorage) -> Option<Vec<u8>> {
    #[cfg(feature = "failpoints")]
    if rows(sql, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_repo_token_key_unset'", vec![])
        .map_or(true, |found| !found.is_empty())
    {
        return None;
    }
    #[cfg(not(feature = "failpoints"))]
    let _ = sql;
    let secret = env.secret(KEY_SECRET).ok()?.to_string();
    let key = parse_key(&secret);
    if key.is_none() {
        console_error!("repo_token.key_invalid");
    }
    key
}

/// A refusal from the decision, as the API answers it. Every code is fixed, and none carries a token.
fn refused(refusal: AccessRefusal) -> ApiError {
    match refusal {
        AccessRefusal::Grant(_) | AccessRefusal::NotAllowed | AccessRefusal::ControllerDeparted => {
            ApiError::api(403, refusal.code())
        }
        AccessRefusal::AccessRevoked => ApiError::access_revoked(),
        AccessRefusal::AgentDisconnected => ApiError::agent_disconnected(),
        AccessRefusal::DeadlineUnknown | AccessRefusal::BudgetUnknown => {
            ApiError::api(503, refusal.code())
        }
        _ => ApiError::api(409, refusal.code()),
    }
}

/// What the room learned from `Principal`s before deciding. Neither is ever taken from the request.
#[derive(Clone, Copy)]
struct Standing {
    /// The room's owner still holds their owner authority in the room's organization.
    owner_holds: bool,
    /// The person who linked the agent's credential hasn't left its organization since.
    controller_holds: bool,
}

/// What a decision on current rows came to.
enum Outcome {
    Refused(ApiError),
    /// Return the held token: its sealed copy, with what opens it.
    Reuse {
        sealed: String,
        label: String,
        expires_at: i64,
    },
    Mint(Lease),
}

/// A lease taken to mint: the row that holds it, and what the token is minted for.
#[derive(Clone)]
struct Lease {
    id: String,
    grant: String,
    repo_id: i64,
}

/// The caller's `push` grant row that isn't revoked.
struct PushGrant {
    id: String,
    delegated_by: String,
    repo_id: i64,
    expires_at: Option<i64>,
    revoked_at: Option<i64>,
}

/// The rows a decision reads, owned so the `Grant` can borrow from them.
struct Inputs {
    task: Task,
    grant: Option<PushGrant>,
    owner: Option<String>,
    request: Option<RequestState>,
    link: Option<(LinkStatus, i64, String)>,
    held: Option<(String, i64, String)>,
    public: bool,
}

fn read_inputs(sql: &SqlStorage, agent: &str, task_id: &str) -> R<Option<Inputs>> {
    let Some(task) = load_task(sql, task_id)? else {
        return Ok(None);
    };
    let grant = rows(sql, "SELECT id, delegated_by, provider_repo_id, expires_at, revoked_at FROM provider_grant WHERE principal_id = ? AND action = 'push' AND revoked_at IS NULL", vec![agent.into()])?
        .first()
        .and_then(|g| {
            Some(PushGrant {
                id: text(&g["id"])?,
                delegated_by: text(&g["delegated_by"])?,
                repo_id: g["provider_repo_id"].as_i64()?,
                expires_at: g["expires_at"].as_i64(),
                revoked_at: g["revoked_at"].as_i64(),
            })
        });
    let owner = rows(sql, "SELECT owner_person_id FROM workspace", vec![])?
        .first()
        .and_then(|w| text(&w["owner_person_id"]));
    let request = rows(sql, "SELECT state FROM repo_request", vec![])?
        .first()
        .and_then(|r| r["state"].as_str().and_then(RequestState::from_name));
    let link = rows(
        sql,
        "SELECT status, provider_repo_id, full_name FROM repo_link",
        vec![],
    )?
    .first()
    .and_then(|l| {
        Some((
            LinkStatus::from_name(l["status"].as_str()?)?,
            l["provider_repo_id"].as_i64()?,
            text(&l["full_name"])?,
        ))
    });
    let held = rows(sql, "SELECT sealed, expires_at, grant_id FROM repo_token WHERE agent_id = ? AND task_id = ? AND state = 'held'", vec![agent.into(), task_id.into()])?
        .first()
        .and_then(|h| Some((text(&h["sealed"])?, h["expires_at"].as_i64()?, text(&h["grant_id"])?)));
    Ok(Some(Inputs {
        task,
        grant,
        owner,
        request,
        link,
        held,
        public: public_claims::is_public_participant(sql, agent)?,
    }))
}

/// Policy, then the core decision, on current rows. `Err` is the refusal to answer.
fn decide_now(
    sql: &SqlStorage,
    who: &Participant,
    task_id: &str,
    standing: Standing,
    now: i64,
) -> R<std::result::Result<(Inputs, podster_core::repo_access::Access), ApiError>> {
    let caller = &who.caller;
    let Some(inputs) = read_inputs(sql, &caller.id, task_id)? else {
        return Ok(Err(ApiError::task_not_found()));
    };
    let grant = inputs.grant.as_ref().map(|g| Grant {
        id: &g.id,
        principal: &caller.id,
        provider_repo_id: g.repo_id,
        action: GrantAction::Push,
        delegated_by: &g.delegated_by,
        expires_at: g.expires_at,
        revoked_at: g.revoked_at,
    });
    let holder = inputs
        .owner
        .as_deref()
        .and_then(|owner| delegation_holder(owner, PrincipalKind::Person, standing.owner_holds));
    let link_repo_id = inputs.link.as_ref().map(|(_, id, _)| *id);
    // Without a link there's no repository to hold a grant on. Policy then hides the task or refuses who's asking, and
    // the core decision names the missing link.
    let policy = GrantStanding {
        grant: grant.as_ref(),
        link_repo_id: link_repo_id.unwrap_or(0),
        delegation_holder: holder,
        through_public_claim: inputs.public,
        now,
    };
    if let Err(denial) = authorize_repo_access(caller, &inputs.task, &policy) {
        // An unlinked room's grant check would say `repo_not_linked`, which the core decision says better.
        if !(link_repo_id.is_none()
            && matches!(denial, podster_policy::repositories::RepoDenial::Grant(_)))
        {
            return Ok(Err(super::repositories::denied(denial)));
        }
    }
    let held = inputs
        .held
        .as_ref()
        .map(|(_, expires_at, grant_id)| HeldToken {
            expires_at: *expires_at,
            grant_id,
        });
    let check = AccessCheck {
        task: &inputs.task,
        caller: &caller.id,
        caller_is_agent: caller.kind == PrincipalKind::Agent,
        // `resolve_caller` found a current participant, and the API checked the agent's connection before the room
        // saw the request. A removal or disconnect since then is caught here: it revokes the member row.
        in_room: caller.role != Role::None,
        connected: true,
        controller_holds: standing.controller_holds,
        request: inputs.request,
        link: inputs.link.as_ref().map(|(status, _, _)| *status),
        link_repo_id,
        grant: grant.as_ref(),
        delegation_holder: holder,
        // Ruled for step 6: a task has no server-side deadline or budget today. `due_at` is informational (decision
        // in TASK-PLANNING.md), so it isn't one. Both are passed as explicitly none, on purpose.
        deadline: Deadline::NoDeadline,
        budget: Budget::NoBudget,
        held,
        now,
    };
    let decided = decide_access(&check);
    Ok(match decided {
        Ok(access) => Ok((inputs, access)),
        Err(refusal) => Err(refused(refusal)),
    })
}

/// Marks this agent's held token for the task for revocation, after a refusal: its authority has ended.
fn end_held(sql: &SqlStorage, agent: &str, task_id: &str, now: i64) -> R<()> {
    exec(
        sql,
        "UPDATE repo_token SET state = 'revoke', revoke_next_at = ? WHERE agent_id = ? AND task_id = ? AND state = 'held'",
        vec![now.into(), agent.into(), task_id.into()],
    )
}

/// Counts toward the mint caps, and refuses when either is reached. Old entries go as new ones come.
fn within_caps(sql: &SqlStorage, agent: &str, now: i64) -> R<bool> {
    exec(
        sql,
        "DELETE FROM repo_token_mint WHERE at <= ?",
        vec![(now - HOUR_MS).into()],
    )?;
    let count = |query: &str, bindings: Vec<V>| -> R<i64> {
        Ok(rows(sql, query, bindings)?
            .first()
            .map_or(0, |r| int(&r["n"])))
    };
    let mine = count(
        "SELECT count(*) AS n FROM repo_token_mint WHERE agent_id = ?",
        vec![agent.into()],
    )?;
    let room = count("SELECT count(*) AS n FROM repo_token_mint", vec![])?;
    Ok(mine < MINTS_PER_AGENT_HOUR && room < MINTS_PER_ROOM_HOUR)
}

impl Workspace {
    /// `POST tasks/{task}/repo-access`. Answers as a route that doesn't exist while managed repositories are off.
    pub(super) async fn repo_access(
        &self,
        identity: &Identity,
        who: &Participant,
        task_id: &str,
        raw: &str,
        test_fail: bool,
    ) -> R<Value> {
        let sql = self.state.storage().sql();
        if !provisioning::enabled(&self.env, &sql)? {
            return Err(ApiError::not_found());
        }
        // The caller names the task in the path and nothing else. Any field at all is refused, so nothing can look like
        // a choice of organization, installation, repository or permission.
        let body: Value = if raw.trim().is_empty() {
            json!({})
        } else {
            serde_json::from_str(raw).map_err(|_| ApiError::invalid_argument())?
        };
        if body.as_object().is_none_or(|fields| !fields.is_empty()) {
            return Err(ApiError::invalid_argument());
        }
        // A first look on what the room records, so a caller who'd be refused anyway costs no calls to `Principal`s.
        // It can only refuse: the decision that counts is taken again below, on what they answer.
        let hopeful = Standing {
            owner_holds: true,
            controller_holds: true,
        };
        if let Err(error) = decide_now(&sql, who, task_id, hopeful, now_ms())? {
            // A refusal ends whatever authority a held token had.
            let (agent, task, now) = (who.caller.id.clone(), task_id.to_string(), now_ms());
            self.in_transaction(move |sql| end_held(sql, &agent, &task, now))?;
            return Err(error);
        }
        let standing = self.standing(identity, who).await?;
        let now = now_ms();
        let config = AgentConfig::from_env(&self.env);
        let key = key(&self.env, &sql);
        let room = identity.workspace_id.clone();
        let agent = who.caller.id.clone();
        let task = task_id.to_string();
        let ready = config.is_some() && key.is_some();
        let opener = key.clone();
        let outcome = self.in_transaction({
            let (identity, task, room) = (identity.clone(), task.clone(), room.clone());
            move |sql| {
                let who = resolve_caller(sql, &identity)?;
                command_guard(sql)?;
                // A lease left by a call that never came back is over once its time is.
                exec(sql, "DELETE FROM repo_token WHERE state = 'minting' AND lease_until <= ?", vec![now.into()])?;
                let (inputs, access) = match decide_now(sql, &who, &task, standing, now)? {
                    Ok(allowed) => allowed,
                    Err(error) => {
                        end_held(sql, &who.caller.id, &task, now)?;
                        return Ok(Outcome::Refused(error));
                    }
                };
                match access.token {
                    TokenPlan::ReuseHeld => {
                        let (sealed, expires_at, grant) = inputs.held.ok_or_else(|| ApiError::internal("no held token"))?;
                        Ok(Outcome::Reuse {
                            label: label(&room, access.repo_id, &grant, &who.caller.id, &task),
                            sealed,
                            expires_at,
                        })
                    }
                    TokenPlan::Mint { .. } => {
                        if !ready {
                            return Ok(Outcome::Refused(unavailable()));
                        }
                        if !rows(sql, "SELECT 1 FROM repo_token WHERE agent_id = ? AND task_id = ? AND state = 'minting'", vec![who.caller.id.as_str().into(), task.as_str().into()])?.is_empty() {
                            return Ok(Outcome::Refused(busy()));
                        }
                        if !within_caps(sql, &who.caller.id, now)? {
                            return Ok(Outcome::Refused(ApiError::api(429, "rate_limited")));
                        }
                        let grant = inputs.grant.ok_or_else(|| ApiError::internal("no grant"))?.id;
                        let lease = Lease {
                            id: format!("rtk_{}", uuid::Uuid::new_v4().simple()),
                            grant,
                            repo_id: access.repo_id,
                        };
                        exec(sql, "INSERT INTO repo_token (id, agent_id, task_id, grant_id, provider_repo_id, state, lease_until, created_at) VALUES (?, ?, ?, ?, ?, 'minting', ?, ?)", vec![
                            lease.id.as_str().into(), who.caller.id.as_str().into(), task.as_str().into(), lease.grant.as_str().into(),
                            lease.repo_id.into(), (now + LEASE_MS).into(), now.into(),
                        ])?;
                        exec(sql, "INSERT INTO repo_token_mint (at, agent_id) VALUES (?, ?)", vec![now.into(), who.caller.id.as_str().into()])?;
                        Ok(Outcome::Mint(lease))
                    }
                }
            }
        })?;
        let lease = match outcome {
            Outcome::Refused(error) => return Err(error),
            Outcome::Reuse {
                sealed,
                label,
                expires_at,
            } => {
                let key = opener.ok_or_else(unavailable)?;
                let token = open_labeled(&key, &label, &sealed).map_err(|_| unavailable())?;
                return answer(&sql, token, expires_at);
            }
            Outcome::Mint(lease) => lease,
        };
        let (Some(config), Some(key)) = (config, key) else {
            return Err(unavailable());
        };
        let issuer = AgentTokens::new(config);
        let minted = match issuer
            .mint_agent_token(lease.repo_id, &TokenPermissions::AGENT.pairs())
            .await
        {
            Ok(minted) => minted,
            Err(failure) => {
                self.drop_lease(&lease.id);
                console_error!(
                    "{}",
                    json!({ "event": "repo_token.mint_failed", "ws": room, "task": task, "agent": agent, "status": failure.status() })
                );
                return Err(ApiError::api(502, "provider_unavailable"));
            }
        };
        let granted: Vec<(&str, &str)> = minted
            .permissions
            .iter()
            .map(|(name, level)| (name.as_str(), level.as_str()))
            .collect();
        let after = now_ms();
        if !minted_token_matches(
            lease.repo_id,
            &minted.repo_ids,
            &granted,
            TokenPermissions::AGENT,
        ) || minted.expires_at <= after
            || minted.expires_at > after + LONGEST_LIFE_MS
        {
            self.drop_lease(&lease.id);
            self.dispose(&issuer, &key, &room, &lease, &agent, &task, minted)
                .await;
            console_error!(
                "{}",
                json!({ "event": "repo_token.mismatch", "ws": room, "task": task, "agent": agent })
            );
            return Err(ApiError::api(502, "provider_mismatch"));
        }
        let sealed = match crate::public::fresh_nonce().and_then(|nonce| {
            seal_labeled(
                &key,
                &nonce,
                &label(&room, lease.repo_id, &lease.grant, &agent, &task),
                &minted.token,
            )
            .ok()
        }) {
            Some(sealed) => sealed,
            None => {
                self.drop_lease(&lease.id);
                self.dispose(&issuer, &key, &room, &lease, &agent, &task, minted)
                    .await;
                return Err(unavailable());
            }
        };
        let committed = self.in_transaction({
            let (identity, task, lease, sealed) = (identity.clone(), task.clone(), lease.clone(), sealed.clone());
            let expires_at = minted.expires_at;
            move |sql| {
                let now = now_ms();
                let who = resolve_caller(sql, &identity)?;
                command_guard(sql)?;
                let ours = rows(sql, "SELECT 1 FROM repo_token WHERE id = ? AND state = 'minting'", vec![lease.id.as_str().into()])?;
                if ours.is_empty() {
                    return Ok(Err(busy()));
                }
                match decide_now(sql, &who, &task, standing, now)? {
                    Ok((_, access)) if access.repo_id == lease.repo_id => {}
                    Ok(_) => {
                        exec(sql, "DELETE FROM repo_token WHERE id = ?", vec![lease.id.as_str().into()])?;
                        return Ok(Err(unavailable()));
                    }
                    Err(error) => {
                        exec(sql, "DELETE FROM repo_token WHERE id = ?", vec![lease.id.as_str().into()])?;
                        end_held(sql, &who.caller.id, &task, now)?;
                        return Ok(Err(error));
                    }
                }
                // The token it replaces is revoked once this one is kept, so the agent always has one.
                end_held(sql, &who.caller.id, &task, now)?;
                exec(sql, "UPDATE repo_token SET state = 'held', sealed = ?, expires_at = ?, issued_at = ?, lease_until = NULL WHERE id = ?", vec![
                    sealed.as_str().into(), expires_at.into(), now.into(), lease.id.as_str().into(),
                ])?;
                // IDs only. Nobody is told: the agent asked, and the task's viewers can read it.
                store::record_event_about(sql, "repo_access.issued", &who.caller.id, Some(&lease.grant), Some(&task), &Transition::NONE, Vec::<String>::new(), now)?;
                #[cfg(feature = "failpoints")]
                if test_fail {
                    return Err(ApiError::internal("injected failure"));
                }
                #[cfg(not(feature = "failpoints"))]
                let _ = test_fail;
                Ok(Ok(()))
            }
        });
        match committed {
            Ok(Ok(())) => {
                console_log!(
                    "{}",
                    json!({ "event": "repo_token.issued", "ws": room, "task": task, "agent": agent, "grant": lease.grant })
                );
                answer(&sql, minted.token, minted.expires_at)
            }
            Ok(Err(error)) => {
                self.dispose(&issuer, &key, &room, &lease, &agent, &task, minted)
                    .await;
                Err(error)
            }
            Err(error) => {
                // The commit failed, so the room holds nothing for this token. Take it back now.
                self.drop_lease(&lease.id);
                self.dispose(&issuer, &key, &room, &lease, &agent, &task, minted)
                    .await;
                console_error!(
                    "{}",
                    json!({ "event": "repo_token.commit_failed", "ws": room, "task": task, "agent": agent, "code": error.code().unwrap_or("internal_error") })
                );
                Err(ApiError::internal("repo token not kept"))
            }
        }
    }

    /// Asks the two `Principal`s. An answer that isn't a clear yes or no refuses: nothing is minted on an unknown.
    async fn standing(&self, identity: &Identity, who: &Participant) -> R<Standing> {
        let sql = self.state.storage().sql();
        let room = rows(
            &sql,
            "SELECT owner_person_id, owner_org_id, owner_left_at, owner_since FROM workspace",
            vec![],
        )?;
        let room = room.first().ok_or_else(ApiError::workspace_not_found)?;
        let unknown = || ApiError::api(503, "standing_unknown");
        let owner_holds = match (text(&room["owner_person_id"]), text(&room["owner_org_id"])) {
            (Some(owner), Some(org)) if room["owner_left_at"].is_null() => {
                let since = room["owner_since"].as_i64().unwrap_or(0);
                !principal::departed_since(&self.env, &owner, &org, since)
                    .await
                    .map_err(|_| unknown())?
            }
            _ => false,
        };
        // An agent acts for whoever linked its credential, in the agent's organization. A credential with no linker
        // can't be counted against anyone, so it gets nothing.
        let controller_holds = match &identity.linker {
            Some(linker) => {
                !principal::departed_since(&self.env, &linker.person, &who.org, linker.since)
                    .await
                    .map_err(|_| unknown())?
            }
            None => false,
        };
        Ok(Standing {
            owner_holds,
            controller_holds,
        })
    }

    fn drop_lease(&self, id: &str) {
        let sql = self.state.storage().sql();
        let _ = exec(
            &sql,
            "DELETE FROM repo_token WHERE id = ? AND state = 'minting'",
            vec![id.into()],
        );
    }

    /// Takes back a token nobody may keep. If GitHub can't be reached, it's sealed into a row the alarm retries; if even
    /// that can't be written, it lives out its hour, and the log says so by ID.
    #[allow(clippy::too_many_arguments)]
    async fn dispose(
        &self,
        issuer: &AgentTokens,
        key: &[u8],
        room: &str,
        lease: &Lease,
        agent: &str,
        task: &str,
        minted: Minted,
    ) {
        if issuer.revoke_token(&minted.token).await == Revoked::Gone {
            return;
        }
        let now = now_ms();
        let sql = self.state.storage().sql();
        let queued = crate::public::fresh_nonce()
            .and_then(|nonce| seal_labeled(key, &nonce, &label(room, lease.repo_id, &lease.grant, agent, task), &minted.token).ok())
            .map(|sealed| {
                exec(&sql, "INSERT INTO repo_token (id, agent_id, task_id, grant_id, provider_repo_id, state, sealed, expires_at, created_at, revoke_next_at) VALUES (?, ?, ?, ?, ?, 'revoke', ?, ?, ?, ?)", vec![
                    format!("rtk_{}", uuid::Uuid::new_v4().simple()).into(), agent.into(), task.into(), lease.grant.as_str().into(),
                    lease.repo_id.into(), sealed.into(), minted.expires_at.min(now + HOUR_MS).into(), now.into(), (now + REVOKE_FIRST_WAIT_MS).into(),
                ])
                .is_ok()
            })
            .unwrap_or(false);
        if !queued {
            console_error!(
                "{}",
                json!({ "event": "repo_token.unrevoked", "ws": room, "task": task, "agent": agent })
            );
        }
    }

    /// The alarm's part: marks tokens whose authority has ended, drops what's expired, and revokes what's due. A
    /// failure here holds up nothing else, and nothing here is ever logged but IDs and counts.
    pub(super) async fn repo_token_upkeep(&self) -> R<()> {
        let sql = self.state.storage().sql();
        if !store::is_initialized(&sql)? || store::needs_migration(&sql)? {
            return Ok(());
        }
        let now = now_ms();
        self.in_transaction(move |sql| {
            store::mark_stale_repo_tokens(sql, now)?;
            // An expired token is dead whatever its state, and a lease past its time is abandoned.
            exec(sql, "DELETE FROM repo_token WHERE expires_at <= ? OR (state = 'minting' AND lease_until <= ?)", vec![now.into(), now.into()])
        })?;
        let due = rows(&sql, "SELECT id, agent_id, task_id, grant_id, provider_repo_id, sealed, revoke_attempts, expires_at FROM repo_token WHERE state = 'revoke' AND revoke_next_at <= ? ORDER BY revoke_next_at LIMIT ?", vec![now.into(), REVOKES_PER_ALARM.into()])?;
        if due.is_empty() {
            return Ok(());
        }
        let room = rows(&sql, "SELECT id FROM workspace", vec![])?
            .first()
            .and_then(|r| text(&r["id"]))
            .unwrap_or_default();
        let issuer = AgentConfig::from_env(&self.env).map(AgentTokens::new);
        let key = key(&self.env, &sql);
        let (mut revoked, mut failed) = (0, 0);
        for row in &due {
            let id = text(&row["id"]).unwrap_or_default();
            let token = key
                .as_ref()
                .zip(text(&row["sealed"]))
                .and_then(|(key, sealed)| {
                    let label = label(
                        &room,
                        int(&row["provider_repo_id"]),
                        &text(&row["grant_id"]).unwrap_or_default(),
                        &text(&row["agent_id"]).unwrap_or_default(),
                        &text(&row["task_id"]).unwrap_or_default(),
                    );
                    open_labeled(key, &label, &sealed).ok()
                });
            let outcome = match (&issuer, token) {
                (Some(issuer), Some(token)) => issuer.revoke_token(&token).await,
                _ => Revoked::Failed,
            };
            if outcome == Revoked::Gone {
                revoked += 1;
                exec(
                    &sql,
                    "DELETE FROM repo_token WHERE id = ?",
                    vec![id.as_str().into()],
                )?;
            } else {
                failed += 1;
                let attempts = int(&row["revoke_attempts"]) + 1;
                let wait = (REVOKE_FIRST_WAIT_MS << attempts.min(4)).min(REVOKE_LONGEST_WAIT_MS);
                exec(
                    &sql,
                    "UPDATE repo_token SET revoke_attempts = ?, revoke_next_at = ? WHERE id = ?",
                    vec![
                        attempts.into(),
                        (now_ms() + wait).into(),
                        id.as_str().into(),
                    ],
                )?;
            }
        }
        console_log!(
            "{}",
            json!({ "event": "repo_token.revocations", "ws": room, "revoked": revoked, "failed": failed })
        );
        Ok(())
    }
}

/// When the alarm should next come for tokens: a revocation due, a held token's expiry, or a lease's end.
pub(super) fn next_due(sql: &SqlStorage) -> R<Option<i64>> {
    Ok(rows(
        sql,
        "SELECT min(CASE state WHEN 'revoke' THEN min(revoke_next_at, expires_at) WHEN 'held' THEN expires_at ELSE lease_until END) AS due FROM repo_token",
        vec![],
    )?
    .first()
    .and_then(|r| r["due"].as_f64())
    .map(|due| due as i64))
}

/// The answer: the token, its expiry, where to clone from and what it allows. No idempotency record keeps it.
fn answer(sql: &SqlStorage, token: String, expires_at: i64) -> R<Value> {
    let full_name = rows(sql, "SELECT full_name FROM repo_link", vec![])?
        .first()
        .and_then(|l| text(&l["full_name"]))
        .ok_or_else(|| ApiError::api(409, "repo_not_ready"))?;
    let permissions: serde_json::Map<String, Value> = TokenPermissions::AGENT
        .pairs()
        .iter()
        .map(|(name, level)| ((*name).to_string(), Value::from(*level)))
        .collect();
    Ok(json!({
        "token": token,
        "expires_at": expires_at,
        "repository": full_name,
        "clone_url": format!("https://github.com/{full_name}.git"),
        "permissions": permissions,
        // A task has no deadline on the server yet, so its authority has no fixed end. Renewal rechecks everything.
        "authority_ends_at": Value::Null,
    }))
}
