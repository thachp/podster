//! Grants on a room's repository: giving one, taking it back, and whether one is live (ADR 0009, which is proposed). No I/O.
//!
//! A grant lets one principal do one thing, `push` or `merge`, on one repository. Who may give or take one back is
//! `podster_policy::repositories`. This decides what happens to the room's `provider_grant` rows, and whether a row
//! carries authority now.
//!
//! The room keeps at most one row that isn't revoked for a principal, repository and action. An expired row still
//! counts as that one, so granting again after an expiry revokes it first.

use crate::repositories::GrantAction;

/// One `provider_grant` row, as far as a decision needs it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Grant {
    pub provider_repo_id: i64,
    pub action: GrantAction,
    pub expires_at: Option<i64>,
    pub revoked_at: Option<i64>,
}

impl Grant {
    /// Whether the grant carries authority at `now`: not revoked, and not yet at its expiry, if it has one.
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
    /// `grant_required`: no grant, a revoked one, or one for another repository or another action.
    GrantRequired,
    /// `grant_expired`
    GrantExpired,
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
    /// expiry, and a change of expiry.
    RevokeThenInsert,
    /// The principal already holds exactly this, live. Asking again changes nothing and writes no second row.
    Unchanged,
}

/// Decides a grant of `action` on the room's repository. `link_repo_id` is the room's own linked repository, never a
/// caller's selector, and `None` when the room has none. `held` is the principal's row for this action that isn't
/// revoked, if any. A grant may be given while the link is degraded or suspended: it's only a row, and nothing uses it
/// until the link is ready again.
pub fn decide_grant(
    link_repo_id: Option<i64>,
    held: Option<&Grant>,
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
    let same =
        held.provider_repo_id == repo_id && held.expires_at == expires_at && held.is_live(now);
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

/// Whether a principal holds a live grant for exactly this action on exactly this repository. Run it on every use, from
/// the room's current rows: for each token and each renewal, when a merge is asked for, and again in the merge job
/// before its external call. A grant for another repository or another action is no grant at all (AC-05, AC-10).
pub fn check_grant(
    grant: Option<&Grant>,
    action: GrantAction,
    link_repo_id: i64,
    now: i64,
) -> Result<(), GrantRefusal> {
    let grant = grant
        .filter(|g| {
            g.action == action && g.provider_repo_id == link_repo_id && g.revoked_at.is_none()
        })
        .ok_or(GrantRefusal::GrantRequired)?;
    if !grant.is_live(now) {
        return Err(GrantRefusal::GrantExpired);
    }
    Ok(())
}
