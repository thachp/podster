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
//! `moved` ends the claim, and so does a hostname read gone after its ID was recorded. **One read of gone proves
//! nothing** (`count_gone`): a lost create may still land, and the list may lag. Gone counts only as two reads at least
//! ten minutes apart, the first ten minutes after the create and the last delete, here and in the long end alike. A
//! name's search is read to its last page, up to a bound past which operators are told.
//!
//! **Every way a committed claim ends goes one way** (`podster_core::hostname_requests::end_step`). The room sets the
//! request `ending` and clears and closes the host in one transaction: the owner's removal (8a), the daily recheck's
//! two definite noes a day apart or seven days with no match (8d, `hostname_recheck`), the name's suspension
//! by its notice (step 4(a)), the room unpublishing since the request was made (its release epoch, which only an
//! unpublish moves, so every unpublish trigger is one), the room's own facts read and failing before a provider call
//! (archived, deleted, no longer public, its public surface or app suspended, its organization gone or its release
//! switch taken), Cloudflare's `moved`, and the hostname gone at Cloudflare. Then the hostname's object is told, and
//! marks the claim ending (if it answers that it holds no claim for this request, nothing at Cloudflare is this room's
//! to delete, and the request ends with no call to Cloudflare); the job deletes the custom hostname and **reads until Cloudflare reports it gone,** never
//! taking a delete's answer for that; and only then frees the claim at the object and ends the request. A request for
//! which no create was ever sent has nothing at Cloudflare, so it goes straight to the free. **The long end never waits
//! on a switch, a gate or the room's facts:** it only takes down. It waits only on what it can't read, and on a missing
//! provider when something may be at Cloudflare, which keeps the name held: that fails closed.
//!
//! **Routing (8c):** after each read that finds the custom hostname there, the host starts serving only while routing's
//! local checks hold (`route_local_for`: the gate on claims, the committed claim, no unpublish since, the room's own
//! facts, Cloudflare's `active`) and the hostname's object holds exactly this request's claim, live; it stops as soon as
//! a check is read and fails. The applier asks all of it again before every write of the entry (`takedown`). Once
//! routed and `active`, the status is read every six hours (the deep review's D5).
//!
//! **Room deletion and organization deletion have no source:** nothing deletes either. The room's facts are read before
//! each provider call, so a room marked deleted, or an organization read gone, ends the claim the day either has one.
//!
//! Logs carry the room's and the request's IDs and codes, never a hostname, an ID of Cloudflare's or a token.
use super::hostname::{checked, proof_room};
use super::*;
use crate::custom_hostnames::HostnameProvider;
use podster_core::hostname_requests::{
    after_claimed_read, after_end_read, claimed_step, count_gone, end_step, route_claim,
    route_local, unpublished_since, AfterClaimedRead, AfterEndRead, ClaimedStep, CustomRoute,
    EndStep, GoneCount, ProviderRead, RoomRead, RouteLocal,
};
use podster_core::hostnames::{may_free_claim, Claim, ClaimEnd, HostnameRecord};
use podster_policy::release::{hostname_proof_room, HostnameProofStep};

/// What the room keeps of a request's custom hostname.
struct Phase {
    epoch: Option<u64>,
    create_sent: bool,
    provider_id: Option<String>,
    provider_status: Option<String>,
    object_ending: bool,
    gone: bool,
    create_sent_at: Option<i64>,
    deleted_at: Option<i64>,
    first_gone_at: Option<i64>,
}

fn phase(sql: &SqlStorage, id: &str) -> R<Phase> {
    let found = rows(
        sql,
        "SELECT release_epoch, create_sent_at, provider_id, provider_status, object_ending_at, gone_at, deleted_at, first_gone_at FROM hostname_provider WHERE request_id = ?",
        vec![id.into()],
    )?;
    let row = found.first();
    let at = |name: &str| row.is_some_and(|row| !row[name].is_null());
    let time = |name: &str| {
        row.filter(|row| !row[name].is_null())
            .map(|row| int(&row[name]))
    };
    Ok(Phase {
        epoch: row
            .filter(|row| !row["release_epoch"].is_null())
            .map(|row| takedown::from_stored(int(&row["release_epoch"]))),
        create_sent: at("create_sent_at"),
        provider_id: row.and_then(|row| text(&row["provider_id"])),
        provider_status: row.and_then(|row| text(&row["provider_status"])),
        object_ending: at("object_ending_at"),
        gone: at("gone_at"),
        create_sent_at: time("create_sent_at"),
        deleted_at: time("deleted_at"),
        first_gone_at: time("first_gone_at"),
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
pub(super) fn end_committed(
    sql: &SqlStorage,
    id: &str,
    hostname: &str,
    code: &str,
    now: i64,
) -> R<()> {
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
        // The challenge's daily recheck (8d), when its turn has come, after the room's facts were read again.
        if self.recheck_if_due(sql, row, now).await? {
            return Ok(());
        }
        let create = match claimed_step(phase.create_sent) {
            ClaimedStep::Create => true,
            ClaimedStep::Read => {
                let Some(provider) = provider(&self.env, sql) else {
                    console_error!("hostname: the custom hostname can't be read: room={} request={} code=custom_hostname_provider_missing", room, id);
                    return self.tried(sql, &id, now);
                };
                let read = provider.read(&hostname).await;
                if read.too_long {
                    self.list_too_long(&room, &id, &hostname).await;
                }
                if read.read == ProviderRead::Gone && !self.gone_counted(sql, &id, &phase, now)? {
                    return Ok(());
                }
                match after_claimed_read(read.read, phase.provider_id.is_some()) {
                    AfterClaimedRead::Wait => {
                        console_error!("hostname: the custom hostname couldn't be read: room={} request={} code=custom_hostname_unread", room, id);
                        return self.tried(sql, &id, now);
                    }
                    AfterClaimedRead::End(cause) => {
                        // Read there, `moved`: any read of gone noted before it is forgotten, as on every read that
                        // finds the hostname, so the long end counts afresh.
                        if matches!(read.read, ProviderRead::Present { .. }) {
                            let (store, request) = (sql.clone(), id.clone());
                            transaction_sync(&self.state, move || {
                                set_phase(&store, &request, "first_gone_at = NULL", vec![])
                            })?;
                        }
                        return end(cause.code());
                    }
                    AfterClaimedRead::Keep => {
                        let (found_id, status) = read.found.into_iter().next().unwrap_or_default();
                        let differs = phase.provider_id.as_deref() != Some(found_id.as_str())
                            || phase.provider_status.as_deref() != Some(status.as_str());
                        let (store, request) = (sql.clone(), id.clone());
                        transaction_sync(&self.state, move || {
                            // Read there: any read of gone noted before it is forgotten.
                            set_phase(&store, &request, "first_gone_at = NULL", vec![])?;
                            if differs {
                                set_phase(
                                    &store,
                                    &request,
                                    "provider_id = ?, provider_status = ?",
                                    vec![found_id.into(), status.into()],
                                )?;
                                changed(&store, &request, now)
                            } else {
                                checked(&store, &request, now)
                            }
                        })?;
                        // Routing follows what was just read (8c).
                        return self.route(sql, &room, &id, &hostname, now).await;
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

    /// **Routing** (M6 step 8c), after each read that found the custom hostname there: the host starts serving only
    /// while every local check holds (`route_local_for`, Cloudflare's `active` among them) and the hostname's object
    /// holds exactly this request's claim, live; it stops, closed through `takedown::close_custom_host`, as soon as a
    /// check is read and fails, so its applier takes the entry down. A check that couldn't be read changes nothing.
    /// Every condition is read again inside the transaction that opens it, except the object's, which can't be; the
    /// applier asks the object again before every write of the entry.
    async fn route(
        &self,
        sql: &SqlStorage,
        room: &str,
        id: &str,
        hostname: &str,
        now: i64,
    ) -> R<()> {
        let open = custom_host_open(sql, hostname)?;
        let refused = custom_host_refused(sql, hostname)?;
        let local = route_local_for(sql, hostname, self.hostname_claims_open())?.0;
        let route = match local {
            CustomRoute::Serve => route_at_object(&self.env, sql, hostname, room, id).await,
            other => other,
        };
        // No content provider, no applier to write or remove an entry: no custom host is made or reopened, so no row
        // is left that the long end would wait on for ever (the security re-check of PR #404).
        let content = takedown::provider(&self.env, sql).is_some();
        let cause: &'static str = match route {
            CustomRoute::Serve if (open != Some(true) || refused) && !content => {
                "content_provider_missing"
            }
            // Not routed, or routed and refused by the applier at the version it has: (re)opened, so its version moves
            // and the applier asks every check again (the review of PR #404, S3).
            CustomRoute::Serve if open != Some(true) || refused => {
                let claims_open = self.hostname_claims_open();
                let (store, host, request) = (sql.clone(), hostname.to_owned(), id.to_owned());
                let opened = Rc::new(RefCell::new(false));
                let slot = opened.clone();
                transaction_sync(&self.state, move || {
                    let (again, held) = route_local_for(&store, &host, claims_open)?;
                    if again != CustomRoute::Serve || held.as_deref() != Some(request.as_str()) {
                        return Ok(());
                    }
                    if custom_host_open(&store, &host)? == Some(true) {
                        if !custom_host_refused(&store, &host)? {
                            return Ok(());
                        }
                        takedown::close_custom_host(&store, &host, now)?;
                    }
                    *slot.borrow_mut() = open_route(&store, &host, now)?;
                    Ok(())
                })?;
                let did_open = *opened.borrow();
                match (did_open, open == Some(true)) {
                    (true, false) => "custom_host_routed",
                    (true, true) => "custom_host_reopened",
                    (false, _) => "custom_host_not_routed",
                }
            }
            CustomRoute::Serve => "custom_host_routed",
            CustomRoute::Wait(code) => code,
            CustomRoute::Refuse(code) => {
                if open == Some(true) {
                    let (store, host) = (sql.clone(), hostname.to_owned());
                    transaction_sync(&self.state, move || {
                        takedown::close_custom_host(&store, &host, now).map(|_| ())
                    })?;
                }
                code
            }
        };
        // Once for each change of cause, not on every read (the review of PR #404, Q3).
        if cause_changed(id, cause) {
            console_log!(
                "hostname: a custom host's routing: room={} request={} code={}",
                room,
                id,
                cause
            );
        }
        Ok(())
    }

    /// Counts a read of gone (`podster_core::hostname_requests::count_gone`): whether it is confirmed. Otherwise the first
    /// that counts is noted, and either way the try is recorded.
    fn gone_counted(&self, sql: &SqlStorage, id: &str, phase: &Phase, now: i64) -> R<bool> {
        let Some(sent) = phase.create_sent_at else {
            return Ok(true);
        };
        let count = count_gone(sent, phase.deleted_at, phase.first_gone_at, now);
        if count == GoneCount::Confirmed {
            return Ok(true);
        }
        let (store, id) = (sql.clone(), id.to_owned());
        transaction_sync(&self.state, move || {
            if count == GoneCount::First {
                set_phase(&store, &id, "first_gone_at = ?", vec![now.into()])?;
            }
            checked(&store, &id, now)
        })?;
        Ok(false)
    }

    /// The search for a name matched more than a read takes: operators are told, by code, in their own record, with
    /// the name as its subject, which never reaches a log. If the telling fails, the next read tells again.
    async fn list_too_long(&self, room: &str, id: &str, hostname: &str) {
        console_error!("hostname: the custom hostname's list was too long to read: room={} request={} code=custom_hostname_list_too_long", room, id);
        let finding = json!({ "code": "custom_hostname_list_too_long", "subject": hostname });
        let told = crate::moderation::call(
            &self.env,
            crate::reconcile::FINDING_PATH,
            Method::Post,
            Some(finding),
        )
        .await
        .is_ok_and(|response| response.status_code() == 200);
        if !told {
            console_error!("hostname: operators weren't told of a list too long: room={} request={} code=finding_not_kept", room, id);
        }
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
                    "create_sent_at = ?, first_gone_at = NULL",
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
                    .ok()
                    .and_then(|answer| answer["ending"].as_bool());
                match told {
                    None => {
                        console_error!("hostname: the claim's end wasn't recorded: room={} request={} code=claim_no_answer", room, id);
                        return self.tried(sql, &id, now);
                    }
                    // The object holds no claim for this request: whatever Cloudflare holds of the name isn't this
                    // room's to delete. The request ends, and nothing is asked of Cloudflare (the deep review of
                    // PR #403).
                    Some(false) => {
                        console_error!("hostname: the claim wasn't this request's at its object: room={} request={} code=claim_not_held", room, id);
                        let store = sql.clone();
                        return transaction_sync(&self.state, move || ended(&store, &id, now));
                    }
                    Some(true) => {}
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
                if read.too_long {
                    self.list_too_long(&room, &id, &hostname).await;
                }
                match after_end_read(read.read) {
                    AfterEndRead::Wait => {
                        console_error!("hostname: the custom hostname couldn't be read: room={} request={} code=custom_hostname_unread", room, id);
                        self.tried(sql, &id, now)
                    }
                    AfterEndRead::Delete => {
                        // Recorded before it is sent: a read of gone counts only well after the last delete.
                        let store = sql.clone();
                        let request = id.clone();
                        transaction_sync(&self.state, move || {
                            set_phase(
                                &store,
                                &request,
                                "deleted_at = ?, first_gone_at = NULL",
                                vec![now.into()],
                            )?;
                            checked(&store, &request, now)
                        })?;
                        for (found, _) in &read.found {
                            provider.delete(found).await;
                        }
                        Ok(())
                    }
                    AfterEndRead::Gone => {
                        if !self.gone_counted(sql, &id, &phase, now)? {
                            return Ok(());
                        }
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
                // **And the applier has confirmed the entry gone at the host's version** (the review of PR #404, S1).
                // Freed before that, another room could claim the name while this room's entry, which names the
                // same host, is still there to serve on it. Until then the applier keeps trying, from the room's
                // alarm, and the free waits its turn. A room with no row for the host never wrote an entry for it,
                // which is every room with no content provider, since routing makes no row without one.
                if !takedown::entry_confirmed_absent(sql, &hostname)? {
                    console_error!("hostname: the claim waits for its entry to be removed: room={} request={} code=entry_not_confirmed_gone", room, id);
                    return self.tried(sql, &id, now);
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

/// **Routing's local checks for `hostname`** (M6 step 8c), from the room's own rows, so they run inside a transaction
/// too: `podster_core::hostname_requests::route_local` over the gate on claims, the room's open request for the name
/// being `claimed`, no unpublish since it was made, the room's own facts and Cloudflare's last status. Also the open
/// request's ID, if there is one.
pub(super) fn route_local_for(
    sql: &SqlStorage,
    hostname: &str,
    claims_open: bool,
) -> R<(CustomRoute, Option<String>)> {
    let found = rows(
        sql,
        "SELECT q.id, q.state, p.release_epoch, p.provider_status FROM hostname_request q
           LEFT JOIN hostname_provider p ON p.request_id = q.id WHERE q.hostname = ? AND q.open = 1",
        vec![hostname.into()],
    )?;
    let row = found.first();
    let request = row.and_then(|row| text(&row["id"]));
    let request_epoch = row
        .filter(|row| !row["release_epoch"].is_null())
        .map(|row| takedown::from_stored(int(&row["release_epoch"])));
    let status = row.and_then(|row| text(&row["provider_status"]));
    let room = match hostname_proof_room(&proof_room(sql)?) {
        HostnameProofStep::Go => RoomRead::Holds,
        HostnameProofStep::Wait => RoomRead::Unread,
        HostnameProofStep::End(denial) => RoomRead::Fails(denial.code()),
    };
    let route = route_local(&RouteLocal {
        claims_open,
        request_claimed: row.is_some_and(|row| row["state"].as_str() == Some("claimed")),
        unpublished: unpublished_since(
            request_epoch,
            takedown::release_epoch(sql).map(takedown::from_stored),
        ),
        room,
        cloudflare_status: status.as_deref(),
    });
    Ok((route, request))
}

/// One call to a hostname's own object, by its normalized name: its answer, or an error for anything but `200`.
pub(super) async fn claim_call(
    env: &Env,
    hostname: &str,
    method: Method,
    path: &str,
    body: Option<Value>,
) -> R<Value> {
    let stub = env
        .durable_object("HOSTNAME_CLAIM")?
        .id_from_name(hostname)?
        .get_stub()?;
    let mut response = crate::forward(
        stub,
        path,
        "",
        Headers::new(),
        method,
        body.map(|body| body.to_string()),
    )
    .await?;
    if response.status_code() != 200 {
        return Err(ApiError::internal("the hostname's object refused"));
    }
    Ok(response.json::<Value>().await?)
}

/// **Routing's check at the hostname's object** (M6 step 8c), read just now: `podster_core::hostname_requests::route_claim`
/// over what the object holds. An answer that couldn't be read, or isn't exactly the expected shape, is no answer and
/// waits; a claim in any state but `live` serves nothing.
pub(super) async fn route_at_object(
    env: &Env,
    sql: &SqlStorage,
    hostname: &str,
    room: &str,
    request: &str,
) -> CustomRoute {
    // Test builds only: the hostname's object can't be read, as if it hadn't answered.
    #[cfg(feature = "failpoints")]
    if rows(
        sql,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_claim_object_unread'",
        vec![],
    )
    .map_or(true, |found| !found.is_empty())
    {
        return route_claim(None, room, request);
    }
    let _ = sql;
    let answer = claim_call(env, hostname, Method::Get, "/internal/state", None)
        .await
        .ok();
    let read = answer.as_ref().and_then(|answer| {
        let suspended = answer["suspended"].as_bool()?;
        let claim = match &answer["claim"] {
            Value::Null => None,
            claim => Some((
                claim["workspace_id"].as_str()?,
                claim["request_id"].as_str()?,
                claim["state"].as_str()?,
            )),
        };
        Some((suspended, claim))
    });
    let record = read.map(|(suspended, claim)| HostnameRecord {
        claim: claim.map(|(room, request, _)| Claim { room, request }),
        ending: claim.is_some_and(|(_, _, state)| state != "live"),
        suspended,
        last_freed_at: None,
        last_suspended_at: None,
        last_lifted_at: None,
        generation: 0,
    });
    route_claim(record.as_ref(), room, request)
}

/// Whether the room's host for `hostname` is a custom host and open: `None` with no row for it.
fn custom_host_open(sql: &SqlStorage, hostname: &str) -> R<Option<bool>> {
    Ok(rows(
        sql,
        "SELECT closed FROM serve_state WHERE host = ? AND kind = 'custom'",
        vec![hostname.into()],
    )?
    .first()
    .map(|row| int(&row["closed"]) == 0))
}

/// **Routing starts** (M6 step 8c; ADR 0010's "Custom domains", step 5), in the caller's transaction: the custom host
/// is made if the room never had it, closed, and then opened through `podster_core::release::open_host`, on the release
/// the room last confirmed served on its default host, or on nothing. Each later release switches it, since a commit
/// writes every open host. Answers whether it opened. A room with no release configuration, or no default host, has
/// nothing to route, and nothing is written.
fn open_route(sql: &SqlStorage, hostname: &str, now: i64) -> R<bool> {
    let has_default = !rows(
        sql,
        "SELECT 1 AS d FROM serve_state WHERE kind = 'default' AND host NOT IN (SELECT host FROM serve_retired)",
        vec![],
    )?
    .is_empty();
    if takedown::load(sql)?.is_none() || !has_default {
        return Ok(false);
    }
    exec(
        sql,
        "INSERT INTO serve_state (host, kind, version, closed, updated_at) VALUES (?, 'custom', 1, 1, ?) ON CONFLICT (host) DO NOTHING",
        vec![hostname.into(), now.into()],
    )?;
    let loaded = takedown::load(sql)?.ok_or_else(|| ApiError::internal("no release state"))?;
    let index = loaded
        .hosts
        .iter()
        .position(|host| host == hostname)
        .ok_or_else(|| ApiError::internal("a host that isn't in the serve state"))?;
    let Some(after) = podster_core::release::open_host(&loaded.state, index) else {
        return Ok(false);
    };
    // Opened first, since a closed host can name no script; then the state core decided, whole.
    exec(
        sql,
        "UPDATE serve_state SET closed = 0 WHERE host = ? AND kind = 'custom'",
        vec![hostname.into()],
    )?;
    release_commit::write_state(sql, &loaded.hosts, &after, now)?;
    Ok(true)
}

thread_local! {
    /// What routing last found for each request this running copy has looked at, so a cause is logged once for each
    /// change, not on every read. Kept in memory only: a restarted object logs its first cause again.
    static ROUTE_CAUSE: RefCell<std::collections::HashMap<String, &'static str>> =
        RefCell::new(std::collections::HashMap::new());
}

/// Records `cause` for `request`: whether it differs from the last one recorded.
fn cause_changed(request: &str, cause: &'static str) -> bool {
    ROUTE_CAUSE.with(|known| known.borrow_mut().insert(request.to_owned(), cause) != Some(cause))
}

/// Whether the applier refused the custom host for `hostname` at the version it has now.
fn custom_host_refused(sql: &SqlStorage, hostname: &str) -> R<bool> {
    Ok(!rows(
        sql,
        "SELECT 1 AS r FROM serve_state s JOIN serve_apply a ON a.host = s.host
           WHERE s.host = ? AND s.kind = 'custom' AND a.refused_version = s.version",
        vec![hostname.into()],
    )?
    .is_empty())
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
