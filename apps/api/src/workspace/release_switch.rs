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
            let trigger = UnpublishTrigger::ReleaseTakenFromOrganization;
            if takedown::unpublish_app(sql, trigger, None, now)? {
                audit_as(
                    sql,
                    moderation::PODSTER,
                    moderation::PODSTER_KIND,
                    "app.unpublished",
                    "app",
                    None,
                    Some(
                        json!({ "reason": trigger.code(), "cause": "release_switch", "generation": seen.generation })
                            .to_string(),
                    ),
                    now,
                )?;
                record_event(
                    sql,
                    "app.unpublished",
                    moderation::PODSTER,
                    None,
                    &Transition {
                        reason: Some(trigger.code()),
                        ..Transition::NONE
                    },
                    roles::room_managers(sql, moderation::PODSTER)?,
                    now,
                )?;
            }
        }
    }
    Ok(decision)
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

    /// Reads the organization's switch from its own object, for the room's organization, and applies it.
    pub(super) async fn read_and_apply_switch(&self) {
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
    /// - A room that doesn't exist answers `known: false`, so the object stops asking. A room still being made reads the
    ///   switch itself as it is made, and every release command reads it again.
    /// - **Refused, never acknowledged:** a notice naming an organization that isn't the room's own, a body that isn't a
    ///   switch, or a switch core refuses as malformed. The object keeps it and sends it again, and tells operators
    ///   once it has gone unanswered long enough. Each refusal is logged by IDs.
    pub(super) async fn release_switch_notice(&self, mut req: Request) -> R<Value> {
        let sql = self.state.storage().sql();
        if !store::is_initialized(&sql)? {
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
