//! Whether an agent gets a token for the room's repository, and with what (ADR 0009, which is proposed). No I/O.
//!
//! This is the pure part of `get_repo_access`. The room reads everything here from its own current rows and from the
//! agent's `Principal`, and asks GitHub for nothing unless this allows it (M5-05). A renewal is the same call with the
//! same checks, so it never widens a token and never extends a task (AC-27). Nothing here comes from the caller but the
//! task it names: the repository is the room's link, and the organization and installations are configuration.
//!
//! **Run `podster_policy::repositories::authorize_repo_access` first.** It decides whether the caller may know the task
//! exists. This answers `task_not_linked` and `repo_not_ready` before it looks at the grant, so run alone it would tell
//! a caller who can't see the task something about it.
//!
//! When this refuses and the room still holds a token for the agent and task, that token's authority has ended, and the
//! room tries to revoke it.

use crate::repo_grants::{check_grant, Grant, GrantRefusal, GrantUse};
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
    /// `None` is no access to contents at all, and the permission isn't asked for.
    pub contents: Option<Level>,
    pub pull_requests: Option<Level>,
    pub metadata: Level,
    /// Commit statuses. The merge App's marking token writes them, and the checks reader reads them.
    pub statuses: Option<Level>,
    /// Check runs. Only the checks reader has it.
    pub checks: Option<Level>,
}

impl TokenPermissions {
    /// An agent's token: task branches and pull requests on one repository. No administration, statuses or workflows.
    pub const AGENT: TokenPermissions = TokenPermissions {
        contents: Some(Level::Write),
        pull_requests: Some(Level::Write),
        metadata: Level::Read,
        statuses: None,
        checks: None,
    };

    /// The server's own read of a pull request (M5 step 7a): the same App, with pull requests and metadata to read and
    /// nothing else. It can't read the repository's contents, and can't write anything.
    pub const READER: TokenPermissions = TokenPermissions {
        contents: None,
        pull_requests: Some(Level::Read),
        metadata: Level::Read,
        statuses: None,
        checks: None,
    };

    /// The merge App's token for marking the reviewed commit (M5 step 7b): commit statuses and nothing else. It can't
    /// merge, push or read the repository's contents.
    pub const MARKER: TokenPermissions = TokenPermissions {
        contents: None,
        pull_requests: None,
        metadata: Level::Read,
        statuses: Some(Level::Write),
        checks: None,
    };

    /// The merge App's token for reading a pull request and the default branch when the job picks a merge up again:
    /// nothing it can write with.
    pub const OBSERVER: TokenPermissions = TokenPermissions {
        contents: Some(Level::Read),
        pull_requests: Some(Level::Read),
        metadata: Level::Read,
        statuses: None,
        checks: None,
    };

    /// The merge App's token for the merge call and the reads around it: contents and pull requests. It can't set a
    /// status.
    pub const MERGER: TokenPermissions = TokenPermissions {
        contents: Some(Level::Write),
        pull_requests: Some(Level::Write),
        metadata: Level::Read,
        statuses: None,
        checks: None,
    };

    /// The server's own read of a commit's statuses and check runs (M5 step 8): nothing it can write with, and no
    /// contents. The agent-token App must hold both for this to be minted, which is the owner's to add.
    pub const CHECKS_READER: TokenPermissions = TokenPermissions {
        contents: None,
        pull_requests: None,
        metadata: Level::Read,
        statuses: Some(Level::Read),
        checks: Some(Level::Read),
    };

    /// The permissions as GitHub names them, to ask for and to compare its answer with.
    pub fn pairs(self) -> Vec<(&'static str, &'static str)> {
        [
            self.checks.map(|level| ("checks", level.name())),
            self.contents.map(|level| ("contents", level.name())),
            Some(("metadata", self.metadata.name())),
            self.pull_requests
                .map(|level| ("pull_requests", level.name())),
            self.statuses.map(|level| ("statuses", level.name())),
        ]
        .into_iter()
        .flatten()
        .collect()
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
pub struct HeldToken<'a> {
    pub expires_at: i64,
    /// The grant row it was minted under.
    pub grant_id: &'a str,
}

/// When a task's authority to run ends. The room must say which of the three it is: a state it can't read is `Unknown`,
/// and refuses.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Deadline {
    /// Fixed when it was set. A renewal never moves it.
    At(i64),
    /// The task was explicitly given no deadline.
    NoDeadline,
    /// Nothing says whether there's a deadline.
    Unknown,
}

/// What's left of a task's budget, with the same three states and the same rule for the unknown one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Budget {
    Remaining,
    Exhausted,
    /// The task was explicitly given no budget.
    NoBudget,
    Unknown,
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
    /// The person who linked the agent's credential is still in the organization they linked it from, since then. An
    /// agent acts for that person, so once they've left it gets nothing new, as their other authority ends (M5 step 6).
    pub controller_holds: bool,
    pub request: Option<RequestState>,
    pub link: Option<LinkStatus>,
    /// The room's linked repository, when it has one.
    pub link_repo_id: Option<i64>,
    /// The caller's `push` grant row that isn't revoked, if any.
    pub grant: Option<&'a Grant<'a>>,
    /// The grant's giver, if they still hold authority over the room's repository: see [`GrantUse::delegation_holder`].
    pub delegation_holder: Option<&'a str>,
    pub deadline: Deadline,
    pub budget: Budget,
    pub held: Option<HeldToken<'a>>,
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
    /// `controller_departed`: the person the agent acts for has left, or the room can't name them.
    ControllerDeparted,
    /// `task_not_linked`: the task has no linked repository.
    TaskNotLinked,
    /// `repo_not_ready`
    RepoNotReady,
    /// `task_not_active`: the task isn't accepted and being worked on: it was submitted, completed, released or canceled.
    TaskNotActive,
    /// `deadline_passed`
    DeadlinePassed,
    /// `deadline_unknown`: the room can't say whether the task has a deadline, so nothing is issued.
    DeadlineUnknown,
    /// `budget_exhausted`
    BudgetExhausted,
    /// `budget_unknown`
    BudgetUnknown,
    /// `grant_required`, `grant_expired` or `grant_stale`
    Grant(GrantRefusal),
}

impl AccessRefusal {
    pub fn code(self) -> &'static str {
        match self {
            AccessRefusal::NotAllowed => "not_allowed",
            AccessRefusal::AccessRevoked => "access_revoked",
            AccessRefusal::AgentDisconnected => "agent_disconnected",
            AccessRefusal::ControllerDeparted => "controller_departed",
            AccessRefusal::TaskNotLinked => "task_not_linked",
            AccessRefusal::RepoNotReady => "repo_not_ready",
            AccessRefusal::TaskNotActive => "task_not_active",
            AccessRefusal::DeadlinePassed => "deadline_passed",
            AccessRefusal::DeadlineUnknown => "deadline_unknown",
            AccessRefusal::BudgetExhausted => "budget_exhausted",
            AccessRefusal::BudgetUnknown => "budget_unknown",
            AccessRefusal::Grant(refusal) => refusal.code(),
        }
    }
}

/// Where the token comes from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TokenPlan {
    /// Return the token the room holds. Nothing is asked of GitHub.
    ReuseHeld,
    /// Ask GitHub for one. `replace_held` says the room holds one that can't be returned: it's at or near its expiry, or
    /// it was minted under another grant. It goes when the new one is kept, so the agent still has one.
    Mint { replace_held: bool },
}

/// An allowed request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Access {
    pub repo_id: i64,
    pub permissions: TokenPermissions,
    pub token: TokenPlan,
    /// When the task's authority ends, which the answer gives beside the token's own expiry. A token can outlive it.
    /// `None` is a task explicitly given no deadline.
    pub authority_ends_at: Option<i64>,
}

/// Decides a token request, and every renewal the same way. The caller must have passed
/// `podster_policy::repositories::authorize_repo_access` first: see the module's note on the order of refusals.
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
    if !check.controller_holds {
        return Err(AccessRefusal::ControllerDeparted);
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
    let authority_ends_at = match check.deadline {
        Deadline::Unknown => return Err(AccessRefusal::DeadlineUnknown),
        Deadline::At(at) if check.now >= at => return Err(AccessRefusal::DeadlinePassed),
        Deadline::At(at) => Some(at),
        Deadline::NoDeadline => None,
    };
    match check.budget {
        Budget::Unknown => return Err(AccessRefusal::BudgetUnknown),
        Budget::Exhausted => return Err(AccessRefusal::BudgetExhausted),
        Budget::Remaining | Budget::NoBudget => {}
    }
    let usage = GrantUse {
        principal: check.caller,
        action: GrantAction::Push,
        link_repo_id: repo_id,
        delegation_holder: check.delegation_holder,
        now: check.now,
    };
    check_grant(check.grant, &usage).map_err(AccessRefusal::Grant)?;
    let grant_id = check.grant.map(|g| g.id);
    let token = match check.held {
        Some(held)
            if Some(held.grant_id) == grant_id
                && held.expires_at.saturating_sub(check.now) > TOKEN_RENEW_BEFORE_MS =>
        {
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
        authority_ends_at,
    })
}
