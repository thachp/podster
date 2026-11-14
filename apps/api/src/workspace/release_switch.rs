//! The room's side of decision 218's release switch (PR C): the switch the room last applied, and what it does with a
//! newer answer about its organization's switch.
//!
//! - **What the room applied** is one row, `release_switch_applied`, added by room schema step 40. **A room that
//!   existed before that step starts unset**, `ReleaseSwitch::UNSET`, which is the column defaults: so it comes down at
//!   its first answer that shows any take, including one an operator made before this code was deployed. A room made
//!   after it starts from the switch it read while being made (`ReleaseSwitch::start_for_room`), or unset if that read
//!   failed, which fails closed the same way.
//! - **Answers come two ways and take one rule,** `podster_core::release::apply_release_switch`:
//!   - a **notice** the organization's own object sends to every room in its `org_room` list after each set, and sends
//!     again until the room acknowledges it ([`Workspace::release_switch_notice`]);
//!   - the room's **own read** of that object, at every release command (`release_recheck::release_reads`) and each
//!     time the reconcile asks the room anything, its walk included (`takedown::takedown_check`). This is the backstop
//!     for a room the list doesn't name, and it is enough on its own: a room whose read shows a take since what it
//!     applied unpublishes itself exactly as the notice would have made it.
//! - **Taking release away unpublishes the room's app** with `UnpublishTrigger::ReleaseTakenFromOrganization`, in the
//!   same transaction that records the switch. A room with nothing up still raises its epoch, so a release staged or
//!   in flight can never go live after it: its confirm fails `EpochMoved`, and the release bookkeeping that runs right
//!   after ends every release that hadn't gone live. A release that had already gone live is unpublished with the rest.
//!   **Giving release back restores nothing.** Only an answer whose last take is newer than what the room applied
//!   unpublishes, so a reconcile that reads the same taken switch again does nothing more.
//! - **The unpublish is Podster's act** (`podster_policy::release::release_switch_notice_is_for_room`): audited as
//!   Podster with the cause `release_switch` and the generation, and told to the room's managers as the event
//!   `app.unpublished` with the reason `release_not_delegated`. The operator who set the switch is in the operators'
//!   own record of the set, never in the room.
//!
//! Logs carry the room's ID, the organization's ID, generations and codes. Nothing else.
use super::*;
use podster_core::release::{apply_release_switch, ReleaseSwitch, SwitchApplied, UnpublishTrigger};

/// The organization's object's call: a notice about its release switch. Nothing outside the Worker reaches it.
pub(crate) const INTERNAL_RELEASE_SWITCH_NOTICE: &str = "/internal/release-switch-notice";

/// What a stored row that can't be a switch is read as: a switch that isn't well formed, so nothing is decided from it.
/// The table's checks keep such a row out; this is only what the room does if one were there.
const UNREADABLE: ReleaseSwitch = ReleaseSwitch {
    granted: false,
    generation: 0,
    last_take: 0,
};

/// The switch the room last applied. With no row, which only a room that never migrated could have, it is unset.
pub(super) fn applied(sql: &SqlStorage) -> R<ReleaseSwitch> {
    let found = rows(
        sql,
        "SELECT granted, generation, last_take FROM release_switch_applied WHERE singleton = 1",
        vec![],
    )?;
    let Some(row) = found.first() else {
        return Ok(ReleaseSwitch::UNSET);
    };
    let (Some(granted), Some(generation), Some(last_take)) = (
        row["granted"].as_i64(),
        row["generation"]
            .as_i64()
            .and_then(|g| u64::try_from(g).ok()),
        row["last_take"]
            .as_i64()
            .and_then(|t| u64::try_from(t).ok()),
    ) else {
        return Ok(UNREADABLE);
    };
    Ok(ReleaseSwitch {
        granted: granted == 1,
        generation,
        last_take,
    })
}

/// Writes the switch the room now applies. A generation past what storage holds is refused, never written as another.
pub(super) fn record(sql: &SqlStorage, switch: ReleaseSwitch, now: i64) -> R<()> {
    let generation = i64::try_from(switch.generation)
        .map_err(|_| ApiError::internal("a release switch past what the room stores"))?;
    let last_take = i64::try_from(switch.last_take)
        .map_err(|_| ApiError::internal("a release switch past what the room stores"))?;
    exec(
        sql,
        "INSERT INTO release_switch_applied (singleton, granted, generation, last_take, applied_at) VALUES (1, ?, ?, ?, ?)
           ON CONFLICT (singleton) DO UPDATE SET granted = excluded.granted, generation = excluded.generation,
             last_take = excluded.last_take, applied_at = excluded.applied_at",
        vec![
            i64::from(switch.granted).into(),
            generation.into(),
            last_take.into(),
            now.into(),
        ],
    )
}

/// One answer about the organization's switch, in the caller's transaction: core decides, and the room records the
/// switch and, for a take since what it applied, unpublishes. Answers what core decided. A room with no release
/// configuration has no app and no epoch: it records the switch and that is all.
pub(super) fn apply(sql: &SqlStorage, seen: ReleaseSwitch, now: i64) -> R<SwitchApplied> {
    let decision = apply_release_switch(applied(sql)?, seen);
    match decision {
        SwitchApplied::Stale | SwitchApplied::Refused => {}
        SwitchApplied::Record => record(sql, seen, now)?,
        SwitchApplied::Unpublish => {
            record(sql, seen, now)?;
            takedown::unpublish_for(
                sql,
                UnpublishTrigger::ReleaseTakenFromOrganization,
                json!({ "cause": "release_switch", "generation": seen.generation }),
                now,
            )?;
        }
    }
    Ok(decision)
}

/// A room creation under way, counted in the room's `creating` for as long as this lives.
pub(super) struct Creating<'a>(&'a std::cell::Cell<u32>);

impl<'a> Creating<'a> {
    pub(super) fn mark(count: &'a std::cell::Cell<u32>) -> Self {
        count.set(count.get().saturating_add(1));
        Creating(count)
    }
}

impl Drop for Creating<'_> {
    fn drop(&mut self) {
        self.0.set(self.0.get().saturating_sub(1));
    }
}

/// Whether the room has anything the deployment's own switch must take down (M6 step 6): a host whose desired script
/// is set, a kept script, a commit in flight, or a release that hasn't ended. A room with nothing of these has nothing
/// to unpublish, so the switch read again and again changes nothing, with no marker kept: while `RELEASES` is off no
/// release can start, and switching it back on brings nothing back.
fn has_anything_up(sql: &SqlStorage) -> R<bool> {
    if rows(sql, "SELECT 1 AS configured FROM release_config", vec![])?.is_empty() {
        return Ok(false);
    }
    let open: Vec<String> = podster_core::release::ReleaseState::ALL
        .into_iter()
        .filter(|state| !state.is_final())
        .map(|state| format!("'{}'", state.name()))
        .collect();
    let up = rows(
        sql,
        &format!(
            "SELECT 1 AS up WHERE EXISTS (SELECT 1 FROM serve_state WHERE script_name IS NOT NULL)
               OR EXISTS (SELECT 1 FROM release_config WHERE kept_previous IS NOT NULL OR in_flight_release IS NOT NULL)
               OR EXISTS (SELECT 1 FROM release WHERE state IN ({}))",
            open.join(", ")
        ),
        vec![],
    )?;
    Ok(!up.is_empty())
}

/// The deployment's own switch read off, applied in the caller's transaction: if the room has anything up, it is
/// unpublished as `UnpublishTrigger::ReleaseOffForDeployment` (ADR 0010), and permanently, as every unpublish is.
/// Answers whether it unpublished.
pub(super) fn apply_deployment_off(sql: &SqlStorage, now: i64) -> R<bool> {
    if !has_anything_up(sql)? {
        return Ok(false);
    }
    takedown::unpublish_for(
        sql,
        UnpublishTrigger::ReleaseOffForDeployment,
        json!({}),
        now,
    )
}

fn room_id(sql: &SqlStorage) -> String {
    rows(sql, "SELECT id FROM workspace", vec![])
        .ok()
        .and_then(|found| found.first().and_then(|row| text(&row["id"])))
        .unwrap_or_default()
}

fn decision_name(decision: SwitchApplied) -> &'static str {
    match decision {
        SwitchApplied::Stale => "stale",
        SwitchApplied::Record => "recorded",
        SwitchApplied::Unpublish => "unpublished",
        SwitchApplied::Refused => "refused",
    }
}

impl Workspace {
    /// Applies one answer in a transaction of its own, then, if it unpublished, ends the releases that hadn't gone live
    /// and arms the alarm for the applier, as an operator's suspension does. Answers what core decided.
    async fn apply_switch(&self, seen: ReleaseSwitch) -> R<SwitchApplied> {
        let out = Rc::new(RefCell::new(SwitchApplied::Stale));
        let slot = out.clone();
        let store = self.state.storage().sql();
        transaction_sync(&self.state, move || {
            *slot.borrow_mut() = apply(&store, seen, now_ms())?;
            Ok(())
        })?;
        let decision = *out.borrow();
        // Test builds only: the room stops right after each answer it applied, an unpublish before its bookkeeping and
        // its own arm, as an object that died there would. The organization sends the notice again.
        #[cfg(feature = "failpoints")]
        if !rows(
                &self.state.storage().sql(),
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_release_switch_stops_after_commit'",
                vec![],
            )?
            .is_empty()
        {
            return Err(ApiError::internal("test: the room stopped after applying"));
        }
        if decision == SwitchApplied::Unpublish {
            release_commit::bookkeeping(&self.state);
            self.arm(false, false).await?;
        }
        Ok(decision)
    }

    /// The room's own read of its organization's switch, applied: the backstop for a room no notice reaches. A read
    /// that fails, or a failure applying it, is logged by IDs and changes nothing; the caller goes on, and whatever
    /// decides from the switch takes an unread one as undecided.
    pub(super) async fn apply_switch_read(&self, read: Option<ReleaseSwitch>) {
        let Some(seen) = read else {
            return;
        };
        if let Err(error) = self.apply_switch(seen).await {
            let sql = self.state.storage().sql();
            console_error!(
                "release switch: the room's own read wasn't applied: room={} code={}",
                room_id(&sql),
                error.code().unwrap_or("internal_error")
            );
        }
    }

    /// The deployment's own switch as read, `RELEASES`, applied: off, and the room's app comes down if anything is up
    /// (M6 step 6). Read where the organization's switch is read, at the reconcile's question and at every release
    /// command, which is how a room learns of it: there is no notice for a deploy. A failure applying it is logged by
    /// IDs and changes nothing; the next question or command applies it again.
    pub(super) async fn apply_deployment_switch(&self, on: bool) {
        if on {
            return;
        }
        let store = self.state.storage().sql();
        if let Err(error) = transaction_sync(&self.state, move || {
            apply_deployment_off(&store, now_ms()).map(|_| ())
        }) {
            let sql = self.state.storage().sql();
            console_error!(
                "release switch: the deployment's switch wasn't applied: room={} code={}",
                room_id(&sql),
                error.code().unwrap_or("internal_error")
            );
        }
    }

    /// Reads the deployment's switch and the organization's, for the room's organization, and applies both.
    pub(super) async fn read_and_apply_switch(&self) {
        self.apply_deployment_switch(crate::releases::switched_on(&self.env).await)
            .await;
        let sql = self.state.storage().sql();
        let Ok(org) = room_owner_org(&sql) else {
            return;
        };
        let read = crate::principal::org_release_switch(&self.env, &org).await;
        self.apply_switch_read(read).await;
    }

    /// `{ org, granted, generation, last_take }` from the organization's own object, after a set. Answers
    /// `{ known, applied, generation }` with 200, which the object takes as acknowledged.
    ///
    /// - A room that doesn't exist answers `known: false`, so the object stops asking.
    /// - **A room being made doesn't answer.** Its switch read may have been made before the set this notice is about,
    ///   so the notice is left for the object to send again, by when the room exists and applies it.
    /// - **Refused, never acknowledged:** a body that isn't a switch, or a switch core refuses as malformed. The object
    ///   keeps it and sends it again, and tells operators once it has gone unanswered long enough.
    /// - **A notice naming an organization that isn't the room's own** is refused with 403, which only this answers:
    ///   the object then tells operators once and stops sending it.
    ///
    /// Each refusal is logged by IDs.
    ///
    /// **A notice the room answers stale still arms the room,** like every request that isn't a read: the room's
    /// `fetch` arms after each one, whatever it answered. So when an unpublish has committed and its own arm in
    /// `apply_switch` failed or never ran, the notice sent again restores the applier's wake.
    pub(super) async fn release_switch_notice(&self, mut req: Request) -> R<Value> {
        let sql = self.state.storage().sql();
        if !store::is_initialized(&sql)? {
            if self.creating.get() > 0 {
                console_error!("release switch: a notice reached a room still being made: code=room_being_made");
                return Err(ApiError::internal("the room is being made"));
            }
            return Ok(json!({ "known": false, "applied": null, "generation": null }));
        }
        self.migrate_if_needed()?;
        // Test builds only: a test makes the room fail to answer, to show the object keeps the notice and asks again.
        #[cfg(feature = "failpoints")]
        if !rows(
            &sql,
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_refuse_release_switch_notice'",
            vec![],
        )?
        .is_empty()
        {
            return Err(ApiError::internal("test: the room didn't answer"));
        }
        let body: Value =
            serde_json::from_str(&req.text().await?).map_err(|_| ApiError::invalid_argument())?;
        let room = room_id(&sql);
        let notice_org = body["org"].as_str().unwrap_or_default();
        if !podster_policy::release::release_switch_notice_is_for_room(
            &room_owner_org(&sql)?,
            notice_org,
        ) {
            console_error!(
                "release switch: a notice for another organization was refused: room={} org={}",
                room,
                notice_org.chars().take(64).collect::<String>()
            );
            return Err(ApiError::not_allowed());
        }
        let Some(seen) = crate::principal::release_switch_of(&body) else {
            console_error!(
                "release switch: a notice that isn't a switch was refused: room={} code=invalid_argument",
                room
            );
            return Err(ApiError::invalid_argument());
        };
        let decision = self.apply_switch(seen).await?;
        if decision == SwitchApplied::Refused {
            console_error!(
                "release switch: a notice was refused: room={} generation={} code=release_switch_malformed",
                room,
                seen.generation
            );
            return Err(ApiError::internal("release switch refused"));
        }
        let now_applied = applied(&sql)?;
        Ok(json!({
            "known": true,
            "applied": decision_name(decision),
            "generation": now_applied.generation,
        }))
    }
}
