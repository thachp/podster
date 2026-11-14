//! ADR 0010's trigger "nobody who may release now remains" (`UnpublishTrigger::NoReleaserLeft`, `no_releaser`; M6 step
//! 6, 6d, and its follow-up).
//!
//! **The interim rule** (the architect's ruling 3 of 2026-11-13, for the owner to review; ADR 0010 marks this trigger
//! *Assumed, for the owner*, and the owner's table says it is also what holds until the owner answers): someone may
//! release while some person who is the room's owner or one of its admins is in the room and still in their
//! organization (decision 215). An agent never counts, whatever role is stored for it. It is read from the room's own
//! rows: the owner counts until the room records that they left the room's organization, and an admin counts while
//! their place in the room stands, which their organization's departure ends.
//!
//! **Held first, unpublished only once a window passes** (the architect's ruling of 2026-11-13 on the first review of
//! 6d, for the owner to review). The owner's departure from a room with no admin is routine offboarding, and the
//! organization's admin can name a new owner, by recovery, only once the room records it. So a command that leaves
//! nobody **holds** the app: the room keeps what it serves, its releases, its scripts, its epoch and its hosts' versions,
//! and its hosts serve nothing while the hold stands. The hold is its own state, `release_hold`, apart from an operator's suspension of
//! the app, so neither can lift the other. Within `podster_core::release::NO_RELEASER_GRACE_MS` (7 days, *Proposed*,
//! the owner's to change), a command that names someone who may release again, recovery naming an owner or an owner
//! adding an admin, **lifts** it, and the hosts serve again what the room served: the app was only held, so nothing is
//! republished, and nothing new is released without the full recheck. Once the window passes with nobody, the room's
//! alarm unpublishes the app for good, as `no_releaser`, with the clock it ran at.
//!
//! **When it is asked.** At the commands that change who may release, in their own transaction: removing someone,
//! revoking an organization from the room, changing someone's role, adding someone, handing the room to another owner,
//! recovery, and a departure from an organization, which reaches every room through the organization's sweep
//! (`/internal/org-departure`) and is the same code when a held departure replays. Each command is watched as a whole,
//! by core's `releaser_change`: it holds only when someone may release before it and nobody may after, and lifts only
//! when someone may release after it while the app is held. So a same-key retry, answered from its stored answer, and
//! the same departure sent again change nothing more. A grant's revocation here is an organization's: a `deploy` grant
//! decides nothing in this rule, so taking one back changes nothing.
//!
//! **Only a departure can leave nobody today.** Appointing, demoting and removing an admin are the owner's alone
//! (`WorkroomAction::AppointAdmin`), and an owner who may act is a releaser, so none of those can. Handing the room
//! over is one command, in which the new owner takes the room and the former owner becomes an admin together.
//!
//! **A room that already had nobody at deploy is left as it is.** Nothing about it changed, so it is neither held nor
//! unpublished. It can't release anyway: the recheck asks whether the requester may.
use super::*;
use podster_core::release::{
    hold_ended, releaser_change, ReleaserChange, UnpublishTrigger, NO_RELEASER_GRACE_MS,
};
use podster_policy::release::{someone_may_release as policy_someone_may_release, AdminPlace};

/// Whether somebody who may release remains, by `podster_policy::release::someone_may_release` over the room's rows
/// now. The room only reads: whether it records its owner's departure, and each admin row's kind and whether its
/// place stands.
pub(super) fn someone_may_release(sql: &SqlStorage) -> R<bool> {
    let owner_holds = rows(sql, "SELECT owner_left_at FROM workspace", vec![])?
        .first()
        .is_some_and(|room| room["owner_left_at"].is_null());
    let admins: Vec<AdminPlace> = rows(
        sql,
        "SELECT kind, revoked_at FROM member WHERE role = 'admin'",
        vec![],
    )?
    .iter()
    .map(|member| AdminPlace {
        kind: parse_kind(member["kind"].as_str().unwrap_or_default()),
        place_stands: member["revoked_at"].is_null(),
    })
    .collect();
    Ok(policy_someone_may_release(owner_holds, &admins))
}

/// When the room's app is held until, if it is.
pub(super) fn held_until(sql: &SqlStorage) -> R<Option<i64>> {
    Ok(rows(sql, "SELECT until FROM release_hold", vec![])?
        .first()
        .map(|row| int(&row["until"])))
}

/// Makes every host that names a script due to the applier again, so it takes up what the room wants of it now:
/// nothing while held, the same script again once lifted. Only the applier's own record is reset; the room's serve
/// state, and every version a commit wrote, stay as they are, so a commit caught by the hold is still set back host
/// by host (`podster_core::release::set_back`).
fn hosts_again(sql: &SqlStorage) -> R<()> {
    exec(
        sql,
        "UPDATE serve_apply SET applied_version = NULL, applied_at = NULL, applied_script = NULL, refused_version = NULL,
           attempts = 0, attempt_version = NULL, next_attempt_at = NULL
         WHERE host IN (SELECT host FROM serve_state WHERE script_name IS NOT NULL)",
        vec![],
    )
}

/// Audits a change to the hold as Podster's act, and tells the room's managers.
fn record(sql: &SqlStorage, action: &str, details: Value, now: i64) -> R<()> {
    audit_as(
        sql,
        moderation::PODSTER,
        moderation::PODSTER_KIND,
        action,
        "app",
        None,
        Some(details.to_string()),
        now,
    )?;
    record_event(
        sql,
        action,
        moderation::PODSTER,
        None,
        &Transition {
            reason: Some(UnpublishTrigger::NoReleaserLeft.code()),
            ..Transition::NONE
        },
        roles::room_managers(sql, moderation::PODSTER)?,
        now,
    )
}

/// Holds the app: its hosts serve nothing until the hold lifts or runs out. A room with no release configuration has
/// no app, and nothing is held or recorded.
fn hold(sql: &SqlStorage, cause: &str, now: i64) -> R<()> {
    if rows(sql, "SELECT 1 AS configured FROM release_config", vec![])?.is_empty() {
        return Ok(());
    }
    let until = now.saturating_add(NO_RELEASER_GRACE_MS);
    exec(
        sql,
        "INSERT INTO release_hold (singleton, cause, held_at, until) VALUES (1, 'no_releaser', ?, ?)",
        vec![now.into(), until.into()],
    )?;
    hosts_again(sql)?;
    record(
        sql,
        "app.held",
        json!({ "cause": cause, "until": until, "reason": UnpublishTrigger::NoReleaserLeft.code() }),
        now,
    )
}

/// Lifts the hold: the hosts serve again what the room serves.
fn lift(sql: &SqlStorage, cause: &str, now: i64) -> R<()> {
    exec(sql, "DELETE FROM release_hold", vec![])?;
    hosts_again(sql)?;
    record(
        sql,
        "app.hold_lifted",
        json!({ "cause": cause, "reason": UnpublishTrigger::NoReleaserLeft.code() }),
        now,
    )
}

/// Runs one command's change, and holds or lifts the app in the same transaction by what it did to who may release.
/// `cause` is the command's own name, kept beside the trigger's reason so causes stay apart.
pub(super) fn watching<T>(
    sql: &SqlStorage,
    cause: &str,
    now: i64,
    run: impl FnOnce() -> R<T>,
) -> R<T> {
    let before = someone_may_release(sql)?;
    let out = run()?;
    let after = someone_may_release(sql)?;
    match releaser_change(before, after, held_until(sql)?.is_some()) {
        ReleaserChange::Hold => hold(sql, cause, now)?,
        ReleaserChange::Lift => lift(sql, cause, now)?,
        ReleaserChange::Nothing => {}
    }
    Ok(out)
}

/// The room's alarm, at `now`: a hold that has run out unpublishes the app for good, as `no_releaser`, and the hold
/// ends with it. Answers whether it unpublished. A hold that hasn't run out, or no hold, changes nothing.
pub(super) fn settle(sql: &SqlStorage, now: i64) -> R<bool> {
    let Some(until) = held_until(sql)? else {
        return Ok(false);
    };
    if !hold_ended(until, now) {
        return Ok(false);
    }
    exec(sql, "DELETE FROM release_hold", vec![])?;
    takedown::unpublish_for(
        sql,
        UnpublishTrigger::NoReleaserLeft,
        json!({ "cause": "hold_ran_out" }),
        now,
    )
}

/// When the room's alarm must run for its hold, if it is held.
pub(super) fn next_due(sql: &SqlStorage) -> R<Option<i64>> {
    held_until(sql)
}

impl Workspace {
    /// Ends a hold on the room's app that has run out, in its own transaction. A failure is logged by its code and
    /// changes nothing; the next alarm tries again.
    pub(super) fn settle_hold(&self) {
        let sql = self.state.storage().sql();
        if !store::is_initialized(&sql).unwrap_or(false)
            || store::needs_migration(&sql).unwrap_or(true)
        {
            return;
        }
        let store = sql.clone();
        if let Err(error) = transaction_sync(&self.state, move || {
            releasers::settle(&store, release_recheck::release_now(&store)).map(|_| ())
        }) {
            console_error!(
                "the hold on the room's app wasn't settled: code={}",
                error.code().unwrap_or("internal_error")
            );
        }
    }
}
