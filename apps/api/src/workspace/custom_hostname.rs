//! A committed claim's custom hostname at Cloudflare, and the long end of every committed claim (M6 step 8b; ADR 0010's
//! "Custom domains", steps 5, 6 and 8). From the room's proof job, one step a pass, after the applier.
//!
//! **Created only for a committed claim,** a request the room recorded `claimed`, and only once, recorded before it is
//! sent (`hostname_provider.create_sent_at`, in its own transaction, with the request still `claimed`). Before it, the
//! room reads again, failing closed: the gate on claims (`hostname::HOSTNAME_CLAIMS_COMPLETE`), **the gate on creating, the
//! release path's constant (`RELEASE_PATH_COMPLETE`), closed everywhere while it is false,** whatever the providers and
//! `RELEASES` say, and only a test build opens it, for a room a test opts in; a provider for custom hostnames, which no
//! environment configures; release switched on for the deployment and in the room; the room's own facts
//! (`podster_policy::release::hostname_proof_room`); and the hostname's object holding this request's claim, live.
//! Anything unread waits; a fact read and failing ends the claim.
//!
//! **After it, the job reads what Cloudflare holds of the name,** at a wait that doubles from a minute to an hour
//! (`retry_wait_ms`), which also settles a create whose answer was lost: never assumed made, never assumed not.
//! `moved` ends the claim, and so does a hostname read gone after its ID was recorded.
//!
//! **Every way a committed claim ends goes one way** (`podster_core::hostname_requests::end_step`). The room sets the
//! request `ending` and clears and closes the host in one transaction: the owner's removal (8a), the name's suspension
//! by its notice (step 4(a)), the room unpublishing since the request was made (its release epoch, which only an
//! unpublish moves, so every unpublish trigger is one), the room's own facts read and failing before a provider call
//! (archived, deleted, no longer public, its public surface or app suspended, its organization gone or its release
//! switch taken), Cloudflare's `moved`, and the hostname gone at Cloudflare. Then the hostname's object is told, and
//! marks the claim ending; the job deletes the custom hostname and **reads until Cloudflare reports it gone,** never
//! taking a delete's answer for that; and only then frees the claim at the object and ends the request. A request for
//! which no create was ever sent has nothing at Cloudflare, so it goes straight to the free. **The long end never waits
//! on a switch, a gate or the room's facts:** it only takes down. It waits only on what it can't read, and on a missing
//! provider when something may be at Cloudflare, which keeps the name held: that fails closed.
//!
//! **Room deletion and organization deletion have no source:** nothing deletes either. The room's facts are read before
//! each provider call, so a room marked deleted, or an organization read gone, ends the claim the day either has one.
//!
//! Logs carry the room's and the request's IDs and codes, never a hostname, an ID of Cloudflare's or a token.
use super::hostname::{checked, proof_room};
use super::*;
use crate::custom_hostnames::HostnameProvider;
use podster_core::hostname_requests::{
    after_claimed_read, after_end_read, claimed_step, end_step, unpublished_since,
    AfterClaimedRead, AfterEndRead, ClaimedStep, EndStep,
};
use podster_core::hostnames::{may_free_claim, ClaimEnd};
use podster_policy::release::{hostname_proof_room, HostnameProofStep};

/// What the room keeps of a request's custom hostname.
struct Phase {
    epoch: Option<u64>,
    create_sent: bool,
    provider_id: Option<String>,
    provider_status: Option<String>,
    object_ending: bool,
    gone: bool,
}

fn phase(sql: &SqlStorage, id: &str) -> R<Phase> {
    let found = rows(
        sql,
        "SELECT release_epoch, create_sent_at, provider_id, provider_status, object_ending_at, gone_at FROM hostname_provider WHERE request_id = ?",
        vec![id.into()],
    )?;
    let row = found.first();
    let at = |name: &str| row.is_some_and(|row| !row[name].is_null());
    Ok(Phase {
        epoch: row
            .filter(|row| !row["release_epoch"].is_null())
            .map(|row| takedown::from_stored(int(&row["release_epoch"]))),
        create_sent: at("create_sent_at"),
        provider_id: row.and_then(|row| text(&row["provider_id"])),
        provider_status: row.and_then(|row| text(&row["provider_status"])),
        object_ending: at("object_ending_at"),
        gone: at("gone_at"),
    })
}

/// Sets columns of the request's row, making it first if it was never made, in the caller's transaction.
fn set_phase(sql: &SqlStorage, id: &str, assignments: &str, values: Vec<SqlStorageValue>) -> R<()> {
    exec(
        sql,
        "INSERT INTO hostname_provider (request_id) VALUES (?) ON CONFLICT (request_id) DO NOTHING",
        vec![id.into()],
    )?;
    let mut values = values;
    values.push(id.into());
    exec(
        sql,
        &format!("UPDATE hostname_provider SET {assignments} WHERE request_id = ?"),
        values,
    )
}

/// Records the room's release epoch with a request it makes, in the caller's transaction, so an unpublish after it ends
/// any claim it gets.
pub(super) fn record_epoch(sql: &SqlStorage, id: &str) -> R<()> {
    let epoch = takedown::release_epoch(sql);
    set_phase(sql, id, "release_epoch = ?", vec![epoch.into()])
}

/// A request changed now: its next try waits a minute again.
fn changed(sql: &SqlStorage, id: &str, now: i64) -> R<()> {
    exec(
        sql,
        "UPDATE hostname_request SET checked_at = ?, updated_at = ? WHERE id = ?",
        vec![now.into(), now.into(), id.into()],
    )
}

/// The provider for custom hostnames this room may use, or `None`, which is every environment. Test builds also read
/// a table a test makes in one room, `test_custom_hostname_provider_off`.
fn provider(env: &Env, sql: &SqlStorage) -> Option<HostnameProvider> {
    #[cfg(feature = "failpoints")]
    if rows(
        sql,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_custom_hostname_provider_off'",
        vec![],
    )
    .map_or(true, |found| !found.is_empty())
    {
        return None;
    }
    let _ = sql;
    HostnameProvider::from_env(env)
}

/// Sets a committed claim's request `ending`, by `code`, and clears and closes its host, in the caller's transaction.
/// Only a request still `claimed`; for any other, nothing.
fn end_committed(sql: &SqlStorage, id: &str, hostname: &str, code: &str, now: i64) -> R<()> {
    let still = !rows(
        sql,
        "SELECT 1 AS c FROM hostname_request WHERE id = ? AND state = 'claimed'",
        vec![id.into()],
    )?
    .is_empty();
    if !still {
        return Ok(());
    }
    exec(
        sql,
        "UPDATE hostname_request SET state = 'ending', end_reason = ?, updated_at = ? WHERE id = ?",
        vec![code.into(), now.into(), id.into()],
    )?;
    takedown::close_custom_host(sql, hostname, now)?;
    audit_as(
        sql,
        moderation::PODSTER,
        moderation::PODSTER_KIND,
        "app_hostname.ending",
        "app_hostname",
        Some(json!({ "request_id": id, "state": "claimed" }).to_string()),
        Some(json!({ "request_id": id, "state": "ending", "reason": code }).to_string()),
        now,
    )?;
    record_event(
        sql,
        "app_hostname.ending",
        moderation::PODSTER,
        None,
        &Transition::NONE,
        roles::room_managers(sql, moderation::PODSTER)?,
        now,
    )
}

impl Workspace {
    /// **The gate on creating a custom hostname at Cloudflare,** the release path's constant
    /// (`release_commit::RELEASE_PATH_COMPLETE`): closed everywhere while it is false, whatever the providers and
    /// `RELEASES` say. Test builds only: a room a test gave the table `test_custom_hostname_create_open` has it open. A
    /// build without the `failpoints` feature never reads that table.
    fn custom_hostname_create_open(&self) -> bool {
        if release_commit::RELEASE_PATH_COMPLETE {
            return true;
        }
        #[cfg(feature = "failpoints")]
        {
            rows(
                &self.state.storage().sql(),
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_custom_hostname_create_open'",
                vec![],
            )
            .is_ok_and(|found| !found.is_empty())
        }
        #[cfg(not(feature = "failpoints"))]
        {
            false
        }
    }

    /// One step for a committed claim the room holds, `claimed`.
    pub(super) async fn claimed_upkeep(&self, sql: &SqlStorage, row: &Value, now: i64) -> R<()> {
        let id = text(&row["id"]).unwrap_or_default();
        let hostname = text(&row["hostname"]).unwrap_or_default();
        let room = room_id(sql)?;
        let phase = phase(sql, &id)?;
        let end = |code: &'static str| {
            let (store, id, hostname) = (sql.clone(), id.clone(), hostname.clone());
            transaction_sync(&self.state, move || {
                end_committed(&store, &id, &hostname, code, now)
            })
        };
        // The room unpublished since the request was made: every unpublish trigger moves the epoch.
        let epoch = takedown::release_epoch(sql).map(takedown::from_stored);
        if unpublished_since(phase.epoch, epoch) {
            return end(ClaimEnd::Unpublished.code());
        }
        // The room's own facts, read again before any call.
        match hostname_proof_room(&proof_room(sql)?) {
            HostnameProofStep::Go => {}
            HostnameProofStep::Wait => {
                console_error!("hostname: the custom hostname waits on what it couldn't read: room={} request={} code=standing_unknown", room, id);
                return self.tried(sql, &id, now);
            }
            HostnameProofStep::End(denial) => return end(denial.code()),
        }
        let create = match claimed_step(phase.create_sent) {
            ClaimedStep::Create => true,
            ClaimedStep::Read => {
                let Some(provider) = provider(&self.env, sql) else {
                    console_error!("hostname: the custom hostname can't be read: room={} request={} code=custom_hostname_provider_missing", room, id);
                    return self.tried(sql, &id, now);
                };
                let read = provider.read(&hostname).await;
                match after_claimed_read(read.read, phase.provider_id.is_some()) {
                    AfterClaimedRead::Wait => {
                        console_error!("hostname: the custom hostname couldn't be read: room={} request={} code=custom_hostname_unread", room, id);
                        return self.tried(sql, &id, now);
                    }
                    AfterClaimedRead::End(cause) => return end(cause.code()),
                    AfterClaimedRead::Keep => {
                        let (found_id, status) = read.found.into_iter().next().unwrap_or_default();
                        let differs = phase.provider_id.as_deref() != Some(found_id.as_str())
                            || phase.provider_status.as_deref() != Some(status.as_str());
                        let (store, id) = (sql.clone(), id.clone());
                        return transaction_sync(&self.state, move || {
                            if differs {
                                set_phase(
                                    &store,
                                    &id,
                                    "provider_id = ?, provider_status = ?",
                                    vec![found_id.into(), status.into()],
                                )?;
                                changed(&store, &id, now)
                            } else {
                                checked(&store, &id, now)
                            }
                        });
                    }
                    AfterClaimedRead::CreateAgain => true,
                }
            }
        };
        if create {
            self.create_custom_hostname(sql, &room, &id, &hostname, now)
                .await?;
        }
        Ok(())
    }

    /// Records a try that settled nothing, so the next waits longer.
    fn tried(&self, sql: &SqlStorage, id: &str, now: i64) -> R<()> {
        let (store, id) = (sql.clone(), id.to_owned());
        transaction_sync(&self.state, move || checked(&store, &id, now))
    }

    /// Creates the custom hostname for a committed claim, behind every check, recording that it is sent before sending.
    async fn create_custom_hostname(
        &self,
        sql: &SqlStorage,
        room: &str,
        id: &str,
        hostname: &str,
        now: i64,
    ) -> R<()> {
        if !self.hostname_claims_open() || !self.custom_hostname_create_open() {
            console_error!("hostname: no custom hostname was created: room={} request={} code=custom_hostname_create_incomplete", room, id);
            return self.tried(sql, id, now);
        }
        let Some(provider) = provider(&self.env, sql) else {
            console_error!("hostname: no custom hostname was created: room={} request={} code=custom_hostname_provider_missing", room, id);
            return self.tried(sql, id, now);
        };
        let room_on = rows(sql, "SELECT enabled FROM release_config", vec![])?
            .first()
            .is_some_and(|row| int(&row["enabled"]) == 1);
        if !room_on || !crate::releases::switched_on(&self.env).await {
            return self.tried(sql, id, now);
        }
        // The hostname's object must hold exactly this request's claim, live: one ending, or anyone else's, isn't.
        let held = self
            .claim_object(hostname, Method::Get, "/internal/state", None)
            .await
            .ok()
            .map(|answer| {
                answer["claim"]["workspace_id"].as_str() == Some(room)
                    && answer["claim"]["request_id"].as_str() == Some(id)
                    && answer["claim"]["state"].as_str() == Some("live")
            });
        match held {
            Some(true) => {}
            Some(false) => {
                console_error!("hostname: no custom hostname was created: room={} request={} code=claim_not_live", room, id);
                return self.tried(sql, id, now);
            }
            None => {
                console_error!("hostname: no custom hostname was created: room={} request={} code=standing_unknown", room, id);
                return self.tried(sql, id, now);
            }
        }
        // Recorded before it is sent, with the request still claimed, so an ending that follows knows to read.
        let sent = Rc::new(RefCell::new(false));
        let (store, slot, request) = (sql.clone(), sent.clone(), id.to_owned());
        transaction_sync(&self.state, move || {
            let still = !rows(
                &store,
                "SELECT 1 AS c FROM hostname_request WHERE id = ? AND state = 'claimed'",
                vec![request.as_str().into()],
            )?
            .is_empty();
            if still {
                set_phase(
                    &store,
                    &request,
                    "create_sent_at = coalesce(create_sent_at, ?)",
                    vec![now.into()],
                )?;
                checked(&store, &request, now)?;
                *slot.borrow_mut() = true;
            }
            Ok(())
        })?;
        if !*sent.borrow() {
            return Ok(());
        }
        let made = provider.create(hostname).await;
        let (store, request) = (sql.clone(), id.to_owned());
        match made {
            Some((provider_id, status)) => transaction_sync(&self.state, move || {
                set_phase(
                    &store,
                    &request,
                    "provider_id = ?, provider_status = ?",
                    vec![provider_id.into(), status.into()],
                )?;
                changed(&store, &request, now)
            }),
            None => {
                console_error!("hostname: a custom hostname's create wasn't answered: room={} request={} code=custom_hostname_create_unanswered", room, id);
                Ok(())
            }
        }
    }

    /// One step of a committed claim's long end.
    pub(super) async fn long_end_upkeep(&self, sql: &SqlStorage, row: &Value, now: i64) -> R<()> {
        let id = text(&row["id"]).unwrap_or_default();
        let hostname = text(&row["hostname"]).unwrap_or_default();
        let reason =
            text(&row["end_reason"]).unwrap_or_else(|| ClaimEnd::Unmapped.code().to_owned());
        let room = room_id(sql)?;
        let phase = phase(sql, &id)?;
        match end_step(phase.object_ending, phase.create_sent, phase.gone) {
            EndStep::MarkEnding => {
                let body = json!({ "hostname": hostname, "workspace_id": room, "request_id": id, "reason": reason });
                let told = self
                    .claim_object(
                        &hostname,
                        Method::Post,
                        crate::hostname_claim::INTERNAL_END,
                        Some(body),
                    )
                    .await
                    .is_ok_and(|answer| answer["ending"].is_boolean());
                if !told {
                    console_error!("hostname: the claim's end wasn't recorded: room={} request={} code=claim_no_answer", room, id);
                    return self.tried(sql, &id, now);
                }
                let store = sql.clone();
                transaction_sync(&self.state, move || {
                    set_phase(
                        &store,
                        &id,
                        "object_ending_at = coalesce(object_ending_at, ?)",
                        vec![now.into()],
                    )?;
                    changed(&store, &id, now)
                })
            }
            EndStep::Read => {
                let Some(provider) = provider(&self.env, sql) else {
                    console_error!("hostname: the custom hostname can't be deleted: room={} request={} code=custom_hostname_provider_missing", room, id);
                    return self.tried(sql, &id, now);
                };
                let read = provider.read(&hostname).await;
                match after_end_read(read.read) {
                    AfterEndRead::Wait => {
                        console_error!("hostname: the custom hostname couldn't be read: room={} request={} code=custom_hostname_unread", room, id);
                        self.tried(sql, &id, now)
                    }
                    AfterEndRead::Delete => {
                        for (found, _) in &read.found {
                            provider.delete(found).await;
                        }
                        self.tried(sql, &id, now)
                    }
                    AfterEndRead::Gone => {
                        let store = sql.clone();
                        transaction_sync(&self.state, move || {
                            set_phase(
                                &store,
                                &id,
                                "gone_at = coalesce(gone_at, ?)",
                                vec![now.into()],
                            )?;
                            changed(&store, &id, now)
                        })
                    }
                }
            }
            EndStep::Free => {
                // The host's desired serve state is cleared before the claim is freed. Every ending clears it in its
                // own transaction; if it ever weren't, it is cleared now and the free waits its turn.
                let serving = !rows(
                    sql,
                    "SELECT 1 AS s FROM serve_state WHERE host = ? AND (script_name IS NOT NULL OR (kind = 'custom' AND closed = 0))",
                    vec![hostname.as_str().into()],
                )?
                .is_empty();
                if !may_free_claim(!serving, !phase.create_sent || phase.gone) {
                    let (store, host) = (sql.clone(), hostname.clone());
                    return transaction_sync(&self.state, move || {
                        takedown::close_custom_host(&store, &host, now)?;
                        checked(&store, &id, now)
                    });
                }
                let body = json!({ "hostname": hostname, "workspace_id": room, "request_id": id });
                let answer = self
                    .claim_object(
                        &hostname,
                        Method::Post,
                        crate::hostname_claim::INTERNAL_FREE,
                        Some(body),
                    )
                    .await
                    .ok()
                    .and_then(|answer| {
                        Some((answer["freed"].as_bool()?, answer["held"].as_bool()?))
                    });
                match answer {
                    None => {
                        console_error!("hostname: the claim wasn't freed: room={} request={} code=claim_no_answer", room, id);
                        self.tried(sql, &id, now)
                    }
                    // Still live at the object: it is told the claim is ending again before anything is freed.
                    Some((false, true)) => {
                        console_error!("hostname: the claim wasn't ending at its object: room={} request={} code=claim_not_ending", room, id);
                        let store = sql.clone();
                        transaction_sync(&self.state, move || {
                            set_phase(&store, &id, "object_ending_at = NULL", vec![])?;
                            changed(&store, &id, now)
                        })
                    }
                    Some(_) => {
                        let store = sql.clone();
                        transaction_sync(&self.state, move || ended(&store, &id, now))
                    }
                }
            }
        }
    }
}

/// The room's ID.
fn room_id(sql: &SqlStorage) -> R<String> {
    Ok(rows(sql, "SELECT id FROM workspace", vec![])?
        .first()
        .and_then(|row| text(&row["id"]))
        .unwrap_or_default())
}

/// The claim is freed: the request is over, `ended`, keeping the reason it was set ending for.
fn ended(sql: &SqlStorage, id: &str, now: i64) -> R<()> {
    let still = !rows(
        sql,
        "SELECT 1 AS e FROM hostname_request WHERE id = ? AND state = 'ending'",
        vec![id.into()],
    )?
    .is_empty();
    if !still {
        return Ok(());
    }
    exec(
        sql,
        "UPDATE hostname_request SET state = 'ended', open = NULL, end_reason = coalesce(end_reason, 'hostname_unmapped'), ended_at = ?, updated_at = ?, checked_at = ? WHERE id = ?",
        vec![now.into(), now.into(), now.into(), id.into()],
    )?;
    audit_as(
        sql,
        moderation::PODSTER,
        moderation::PODSTER_KIND,
        "app_hostname.ended",
        "app_hostname",
        Some(json!({ "request_id": id, "state": "ending" }).to_string()),
        Some(json!({ "request_id": id, "state": "ended" }).to_string()),
        now,
    )?;
    record_event(
        sql,
        "app_hostname.ended",
        moderation::PODSTER,
        None,
        &Transition::NONE,
        roles::room_managers(sql, moderation::PODSTER)?,
        now,
    )
}
