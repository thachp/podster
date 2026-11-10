//! Whether an agent gets a token for the room's repository, and with what (ADR 0009, which is proposed). No I/O.
//!
//! This is the pure part of `get_repo_access`. The room reads everything here from its own current rows and from the
//! agent's `Principal`, and asks GitHub for nothing unless this allows it (M5-05). A renewal is the same call with the
//! same checks, so it never widens a token and never extends a task (AC-27). Nothing here comes from the caller but the
//! task it names: the repository is the room's link, and the organization and installations are configuration.
//!
//! When this refuses and the room still holds a token for the agent and task, that token's authority has ended, and the
//! room tries to revoke it.

use crate::repo_grants::{check_grant, Grant, GrantRefusal};
use crate::repositories::{coding_work_allowed, GrantAction, LinkStatus, RequestState};
use crate::{Task, TaskStatus};

/// How close to its expiry a held token is replaced by a new one, in milliseconds. Until then a repeated request gets
/// the token the room already holds, so an agent has one live token for a task.
pub const TOKEN_RENEW_BEFORE_MS: i64 = 5 * 60 * 1000;

/// What a repository permission allows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Level {
    Read,
    Write,
}

impl Level {
    pub fn name(self) -> &'static str {
        match self {
            Level::Read => "read",
            Level::Write => "write",
        }
    }
}

/// The permissions a token carries. There's one set, and no request can ask for another.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TokenPermissions {
    pub contents: Level,
    pub pull_requests: Level,
    pub metadata: Level,
}

impl TokenPermissions {
    /// An agent's token: task branches and pull requests on one repository. No administration, statuses or workflows.
    pub const AGENT: TokenPermissions = TokenPermissions {
        contents: Level::Write,
        pull_requests: Level::Write,
        metadata: Level::Read,
    };

    /// The permissions as GitHub names them, to ask for and to compare its answer with.
    pub fn pairs(self) -> [(&'static str, &'static str); 3] {
        [
            ("contents", self.contents.name()),
            ("metadata", self.metadata.name()),
            ("pull_requests", self.pull_requests.name()),
        ]
    }
}

/// Whether GitHub's answer to a token request is exactly what was asked for: the one repository, and these permissions
/// and no others. Anything else is never returned to the agent.
pub fn minted_token_matches(
    link_repo_id: i64,
    answer_repo_ids: &[i64],
    answer_permissions: &[(&str, &str)],
    expected: TokenPermissions,
) -> bool {
    let expected = expected.pairs();
    answer_repo_ids == [link_repo_id]
        && answer_permissions.len() == expected.len()
        && expected
            .iter()
            .all(|pair| answer_permissions.contains(pair))
}

/// A token the room already holds, sealed, for this agent and task.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HeldToken {
    pub expires_at: i64,
}

/// Everything a token request is checked against, read at the time of the request.
#[derive(Clone, Copy, Debug)]
pub struct AccessCheck<'a> {
    pub task: &'a Task,
    /// The caller, as the gateway's assertion names it.
    pub caller: &'a str,
    pub caller_is_agent: bool,
    /// The caller is a current participant of the room.
    pub in_room: bool,
    /// The agent's connection holds: its `Principal` is active and not disconnected.
    pub connected: bool,
    pub request: Option<RequestState>,
    pub link: Option<LinkStatus>,
    /// The room's linked repository, when it has one.
    pub link_repo_id: Option<i64>,
    /// The caller's `push` grant row that isn't revoked, if any.
    pub grant: Option<&'a Grant>,
    /// When the task's authority to run ends, fixed when it was set. A renewal never moves it. `None` is a task with no
    /// deadline.
    pub deadline: Option<i64>,
    pub budget_exhausted: bool,
    pub held: Option<HeldToken>,
    pub now: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AccessRefusal {
    /// `not_allowed`: not an agent, or not the task's assignee.
    NotAllowed,
    /// `access_revoked`: no longer in the room.
    AccessRevoked,
    /// `agent_disconnected`
    AgentDisconnected,
    /// `task_not_linked`: the task has no linked repository.
    TaskNotLinked,
    /// `repo_not_ready`
    RepoNotReady,
    /// `task_not_active`: the task isn't accepted and being worked on: it was submitted, completed, released or canceled.
    TaskNotActive,
    /// `deadline_passed`
    DeadlinePassed,
    /// `budget_exhausted`
    BudgetExhausted,
    /// `grant_required` or `grant_expired`
    Grant(GrantRefusal),
}

impl AccessRefusal {
    pub fn code(self) -> &'static str {
        match self {
            AccessRefusal::NotAllowed => "not_allowed",
            AccessRefusal::AccessRevoked => "access_revoked",
            AccessRefusal::AgentDisconnected => "agent_disconnected",
            AccessRefusal::TaskNotLinked => "task_not_linked",
            AccessRefusal::RepoNotReady => "repo_not_ready",
            AccessRefusal::TaskNotActive => "task_not_active",
            AccessRefusal::DeadlinePassed => "deadline_passed",
            AccessRefusal::BudgetExhausted => "budget_exhausted",
            AccessRefusal::Grant(refusal) => refusal.code(),
        }
    }
}

/// Where the token comes from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TokenPlan {
    /// Return the token the room holds. Nothing is asked of GitHub.
    ReuseHeld,
    /// Ask GitHub for one. `replace_held` says the room holds one at or near its expiry, which goes when the new one is
    /// kept, so the agent still has one.
    Mint { replace_held: bool },
}

/// An allowed request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Access {
    pub repo_id: i64,
    pub permissions: TokenPermissions,
    pub token: TokenPlan,
    /// When the task's authority ends, which the answer gives beside the token's own expiry. A token can outlive it.
    pub authority_ends_at: Option<i64>,
}

/// Decides a token request, and every renewal the same way.
pub fn decide_access(check: &AccessCheck) -> Result<Access, AccessRefusal> {
    if !check.caller_is_agent {
        return Err(AccessRefusal::NotAllowed);
    }
    if !check.in_room {
        return Err(AccessRefusal::AccessRevoked);
    }
    if !check.connected {
        return Err(AccessRefusal::AgentDisconnected);
    }
    if check.task.assignee.as_deref() != Some(check.caller) {
        return Err(AccessRefusal::NotAllowed);
    }
    if !check.task.has_linked_repository {
        return Err(AccessRefusal::TaskNotLinked);
    }
    coding_work_allowed(check.request, check.link).map_err(|_| AccessRefusal::RepoNotReady)?;
    let repo_id = check.link_repo_id.ok_or(AccessRefusal::RepoNotReady)?;
    if check.task.status != TaskStatus::Accepted {
        return Err(AccessRefusal::TaskNotActive);
    }
    if check.deadline.is_some_and(|at| check.now >= at) {
        return Err(AccessRefusal::DeadlinePassed);
    }
    if check.budget_exhausted {
        return Err(AccessRefusal::BudgetExhausted);
    }
    check_grant(check.grant, GrantAction::Push, repo_id, check.now)
        .map_err(AccessRefusal::Grant)?;
    let token = match check.held {
        Some(held) if held.expires_at.saturating_sub(check.now) > TOKEN_RENEW_BEFORE_MS => {
            TokenPlan::ReuseHeld
        }
        held => TokenPlan::Mint {
            replace_held: held.is_some(),
        },
    };
    Ok(Access {
        repo_id,
        permissions: TokenPermissions::AGENT,
        token,
        authority_ends_at: check.deadline,
    })
}
