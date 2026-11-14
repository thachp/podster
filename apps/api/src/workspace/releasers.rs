//! ADR 0010's trigger "nobody who may release now remains" (`UnpublishTrigger::NoReleaserLeft`, `no_releaser`; M6 step
//! 6, 6d).
//!
//! **The interim rule** (the architect's ruling 3 of 2026-11-13, for the owner to review; ADR 0010 marks this trigger
//! *Assumed, for the owner*, and the owner's table says it is also what holds until the owner answers): someone may
//! release while some person who is the room's owner or one of its admins is in the room and still in their
//! organization (decision 215). An agent never counts, whatever role is stored for it. It is read from the room's own
//! rows: the owner counts until the room records that they left the room's organization, and an admin counts while
//! their place in the room stands, which their organization's departure ends.
//!
//! **When it is asked.** At the commands that change who may release, in their own transaction: removing someone,
//! revoking an organization from the room, changing someone's role, handing the room to another owner, and a
//! departure from an organization, which reaches every room through the organization's sweep
//! (`/internal/org-departure`) and is the same code when a held departure replays. Each command is watched as a whole:
//! it fires only when someone may release before it and nobody may after. So it fires once, a same-key retry is
//! answered from its stored answer, and a command that changes nothing about who may release fires nothing. A grant's
//! revocation here is an organization's: a `deploy` grant decides nothing in this rule, so taking one back can't fire it.
//!
//! **Only a departure can fire it today.** Appointing, demoting and removing an admin are the owner's alone
//! (`WorkroomAction::AppointAdmin`), and an owner who may act is a releaser, so none of those can leave nobody. Handing
//! the room over is one command, in which the new owner takes the room and the former owner becomes an admin together.
//! So no two-command transfer or swap passes through a moment with nobody. The other commands are watched all the
//! same, so a later change to who may remove an admin can't skip the rule.
//!
//! **A room that already had nobody at deploy is left as it is.** Nothing about it changed. Its app comes down only
//! when a command takes the last releaser away, which can't happen in it until someone is named again, by the
//! organization's ownership recovery.
use super::*;
use podster_core::release::UnpublishTrigger;
use podster_policy::release::holds_release_authority;

/// Whether some person who is the room's owner or one of its admins is in the room and still in their organization, by
/// the room's rows now.
pub(super) fn someone_may_release(sql: &SqlStorage) -> R<bool> {
    let owner = rows(sql, "SELECT owner_left_at FROM workspace", vec![])?;
    // The owner is a person by construction, and holds while the room records no departure from its organization.
    if owner
        .first()
        .is_some_and(|room| room["owner_left_at"].is_null())
    {
        return Ok(true);
    }
    // An admin's place ends with their removal, their organization revoked from the room, or their departure.
    Ok(rows(
        sql,
        "SELECT kind FROM member WHERE role = 'admin' AND revoked_at IS NULL",
        vec![],
    )?
    .iter()
    .any(|member| {
        let kind = parse_kind(member["kind"].as_str().unwrap_or_default());
        holds_release_authority(kind, Role::Admin, true)
    }))
}

/// Runs one command's change, and fires `no_releaser` in the same transaction if someone could release before it and
/// nobody can after. `cause` is the command's own name, kept beside the trigger's reason so causes stay apart.
pub(super) fn watching<T>(
    sql: &SqlStorage,
    cause: &str,
    now: i64,
    run: impl FnOnce() -> R<T>,
) -> R<T> {
    let before = someone_may_release(sql)?;
    let out = run()?;
    if before && !someone_may_release(sql)? {
        takedown::unpublish_for(
            sql,
            UnpublishTrigger::NoReleaserLeft,
            json!({ "cause": cause }),
            now,
        )?;
    }
    Ok(out)
}
