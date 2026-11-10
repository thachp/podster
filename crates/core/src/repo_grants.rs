//! Grants on a room's repository: giving one, taking it back, and whether one counts (ADR 0009, which is proposed). No I/O.
//!
//! A grant lets one principal do one thing, `push` or `merge`, on one repository. Who may give or take one back is
//! `podster_policy::repositories`. This decides what happens to the room's `provider_grant` rows, and whether a row
//! carries authority now.
//!
//! The room keeps at most one row that isn't revoked for a principal, repository and action. An expired row still
//! counts as that one, so granting again after an expiry revokes it first.
//!
//! A grant rests on its giver. It counts only while whoever gave it still holds the repository's delegation, with their
//! authority still holding. So when a room's ownership moves, no grant is usable until the new owner grants again, and
//! the rows the old owner gave are revoked. Removing a participant revokes the grants they hold.

use crate::repositories::GrantAction;

/// One `provider_grant` row, as far as a decision needs it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Grant<'a> {
    pub id: &'a str,
    /// Who holds it.
    pub principal: &'a str,
    pub provider_repo_id: i64,
    pub action: GrantAction,
    /// Who gave it, from the row's `delegated_by`.
    pub delegated_by: &'a str,
    pub expires_at: Option<i64>,
    pub revoked_at: Option<i64>,
}

impl Grant<'_> {
    /// Whether the grant is neither revoked nor at its expiry. Whether it counts also depends on its giver: see
    /// [`check_grant`].
    pub fn is_live(&self, now: i64) -> bool {
        self.revoked_at.is_none() && self.expires_at.is_none_or(|at| at > now)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GrantRefusal {
    /// `repo_not_linked`: the room has no repository to grant anything on.
    RepoNotLinked,
    /// `invalid_argument`: an expiry that isn't in the future.
    InvalidExpiry,
    /// `grant_required`: no grant, a revoked one, or one for another principal, repository or action.
    GrantRequired,
    /// `grant_expired`
    GrantExpired,
    /// `grant_stale`: whoever gave the grant no longer holds the repository's delegation. The current holder must grant again.
    GrantStale,
    /// `grant_not_found`: nothing to take back.
    GrantNotFound,
}

impl GrantRefusal {
    pub fn code(self) -> &'static str {
        match self {
            GrantRefusal::RepoNotLinked => "repo_not_linked",
            GrantRefusal::InvalidExpiry => "invalid_argument",
            GrantRefusal::GrantRequired => "grant_required",
            GrantRefusal::GrantExpired => "grant_expired",
            GrantRefusal::GrantStale => "grant_stale",
            GrantRefusal::GrantNotFound => "grant_not_found",
        }
    }
}

/// What granting does to the room's rows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GrantPlan {
    /// Add a row.
    Insert,
    /// Revoke the row the principal holds, then add one, in the same transaction. This is every re-grant after an
    /// expiry, a change of expiry, and a grant from a new giver over an earlier giver's row.
    RevokeThenInsert,
    /// The principal already holds exactly this, live, from this giver. Asking again changes nothing and writes no
    /// second row.
    Unchanged,
}

/// Decides a grant of `action` on the room's repository, given by `giver`. `link_repo_id` is the room's own linked
/// repository, never a caller's selector, and `None` when the room has none. `held` is the principal's row for this
/// action that isn't revoked, if any. A grant may be given while the link is degraded or suspended: it's only a row, and
/// nothing uses it until the link is ready again.
pub fn decide_grant(
    link_repo_id: Option<i64>,
    held: Option<&Grant>,
    giver: &str,
    action: GrantAction,
    expires_at: Option<i64>,
    now: i64,
) -> Result<GrantPlan, GrantRefusal> {
    let repo_id = link_repo_id.ok_or(GrantRefusal::RepoNotLinked)?;
    if expires_at.is_some_and(|at| at <= now) {
        return Err(GrantRefusal::InvalidExpiry);
    }
    let Some(held) = held.filter(|g| g.action == action && g.revoked_at.is_none()) else {
        return Ok(GrantPlan::Insert);
    };
    let same = held.provider_repo_id == repo_id
        && held.delegated_by == giver
        && held.expires_at == expires_at
        && held.is_live(now);
    Ok(if same {
        GrantPlan::Unchanged
    } else {
        GrantPlan::RevokeThenInsert
    })
}

/// What taking a grant back does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RevokePlan {
    /// Mark the row revoked. An expired row is revoked like any other, which frees the principal's one place.
    Revoke,
    /// It was already revoked, and nothing changes. A retried revocation can't fail.
    AlreadyRevoked,
}

/// Decides taking back the grant row a caller named, read from the room's own rows.
pub fn decide_revoke(grant: Option<&Grant>) -> Result<RevokePlan, GrantRefusal> {
    match grant {
        None => Err(GrantRefusal::GrantNotFound),
        Some(g) if g.revoked_at.is_some() => Ok(RevokePlan::AlreadyRevoked),
        Some(_) => Ok(RevokePlan::Revoke),
    }
}

/// What a grant is being used for, read from the room's current state.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GrantUse<'a> {
    /// Who is using it.
    pub principal: &'a str,
    pub action: GrantAction,
    /// The room's own linked repository.
    pub link_repo_id: i64,
    /// Who holds the repository's delegation now, with their authority holding: the room's owner. `None` when nobody
    /// does, such as a room whose owner left.
    pub delegation_holder: Option<&'a str>,
    pub now: i64,
}

/// Whether a principal holds a grant that counts: theirs, for exactly this action on exactly this repository, not
/// revoked, not expired, and given by whoever holds the delegation now. Run it on every use, from the room's current
/// rows: for each token and each renewal, when a merge is asked for, and again in the merge job before its external
/// call. A grant for another repository or another action is no grant at all (AC-05, AC-10).
pub fn check_grant(grant: Option<&Grant>, usage: &GrantUse) -> Result<(), GrantRefusal> {
    let grant = grant
        .filter(|g| {
            g.principal == usage.principal
                && g.action == usage.action
                && g.provider_repo_id == usage.link_repo_id
                && g.revoked_at.is_none()
        })
        .ok_or(GrantRefusal::GrantRequired)?;
    if !grant.is_live(usage.now) {
        return Err(GrantRefusal::GrantExpired);
    }
    if usage.delegation_holder != Some(grant.delegated_by) {
        return Err(GrantRefusal::GrantStale);
    }
    Ok(())
}

/// The grants to revoke when a participant is removed from the room or leaves it: every one they hold that isn't
/// revoked yet, by row ID. The removal command revokes them in its own transaction, so someone who comes back holds
/// nothing until they're granted again.
pub fn grants_ended_by_removal<'a>(grants: &[Grant<'a>], removed: &str) -> Vec<&'a str> {
    grants
        .iter()
        .filter(|g| g.revoked_at.is_none() && g.principal == removed)
        .map(|g| g.id)
        .collect()
}

/// The grants to revoke when the repository's delegation moves, which is when the room's ownership does: every one that
/// isn't revoked yet and wasn't given by the new holder, by row ID. `new_holder` is `None` when nobody holds the
/// delegation afterwards. [`check_grant`] already refuses these at use, so this only makes the rows say so.
pub fn grants_ended_by_ownership_change<'a>(
    grants: &[Grant<'a>],
    new_holder: Option<&str>,
) -> Vec<&'a str> {
    grants
        .iter()
        .filter(|g| g.revoked_at.is_none() && new_holder != Some(g.delegated_by))
        .map(|g| g.id)
        .collect()
}
