//! Merge as its own state: asking for one, what the merge job does next, and how it ends (ADR 0009, which is proposed). No I/O.
//!
//! Approval and merge are two events, never one state. Approving a task completes it and merges nothing (AC-17). A merge
//! is asked for separately, by someone who holds a live `merge` grant and didn't submit the work, and it names the
//! approved submission and its commit.
//!
//! GitHub's rules know nothing of a review, so what was reviewed is decided here, before the merge App marks anything.
//! The job reads the pull request itself each time and takes nothing from an earlier read, because an agent's token can
//! edit a pull request. Success is only ever read from the pull request's own state: a second merge call answers `200`.
//!
//! Who may ask at all, by role and visibility, is `podster_policy::repositories`.

use crate::repo_grants::{check_grant, Grant, GrantRefusal};
use crate::repositories::{
    coding_work_allowed, valid_commit_sha, GrantAction, LinkStatus, MergeState, RequestState,
};
use crate::{Task, TaskStatus};

/// Why a merge wasn't asked for, or why the job's recheck of authority stopped it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MergeRefusal {
    /// `task_not_linked`: the task has no linked repository.
    TaskNotLinked,
    /// `repo_not_ready`
    RepoNotReady,
    /// `agent_disconnected`: an agent asked, and its connection no longer holds.
    AgentDisconnected,
    /// `self_merge`: whoever submitted the work never merges it, with a grant or without.
    SelfMerge,
    /// `grant_required` or `grant_expired`
    Grant(GrantRefusal),
    /// `invalid_argument`: the commit isn't a full commit ID.
    InvalidCommit,
    /// `not_approved`: no submission of this task was approved.
    NotApproved,
    /// `submission_mismatch`: the submission named isn't the approved one.
    SubmissionMismatch,
    /// `commit_changed`: the commit named isn't the approved submission's, or an earlier merge already failed because the
    /// head had moved. The way on is a follow-up task with its own review (decision 25).
    CommitChanged,
    /// `change_not_found`: the task has no pull request on the room's repository.
    ChangeNotFound,
    /// `merge_already_requested`
    AlreadyRequested,
    /// `already_merged`
    AlreadyMerged,
}

impl MergeRefusal {
    pub fn code(self) -> &'static str {
        match self {
            MergeRefusal::TaskNotLinked => "task_not_linked",
            MergeRefusal::RepoNotReady => "repo_not_ready",
            MergeRefusal::AgentDisconnected => "agent_disconnected",
            MergeRefusal::SelfMerge => "self_merge",
            MergeRefusal::Grant(refusal) => refusal.code(),
            MergeRefusal::InvalidCommit => "invalid_argument",
            MergeRefusal::NotApproved => "not_approved",
            MergeRefusal::SubmissionMismatch => "submission_mismatch",
            MergeRefusal::CommitChanged => "commit_changed",
            MergeRefusal::ChangeNotFound => "change_not_found",
            MergeRefusal::AlreadyRequested => "merge_already_requested",
            MergeRefusal::AlreadyMerged => "already_merged",
        }
    }
}

/// Who is asking for a merge of what, with everything their authority rests on, read from the room's current rows. The
/// same checks run when the merge is asked for and again in the job before its external call.
#[derive(Clone, Copy, Debug)]
pub struct MergeAuthority<'a> {
    pub task: &'a Task,
    pub request: Option<RequestState>,
    pub link: Option<LinkStatus>,
    /// The room's linked repository, when it has one. Never a caller's selector.
    pub link_repo_id: Option<i64>,
    /// Who asked for the merge.
    pub requester: &'a str,
    /// For an agent, whether its connection holds now. Always true for a person.
    pub requester_connected: bool,
    /// Who made the submission that was approved, from the submission's own row.
    pub submitter: &'a str,
    /// The requester's `merge` grant row that isn't revoked, if any.
    pub grant: Option<&'a Grant>,
    /// The submission and commit the request names.
    pub submission_no: u32,
    pub commit_sha: &'a str,
    pub now: i64,
}

/// Checks the authority for a merge. Authority comes first and the task's state after, so a caller with no grant learns
/// nothing about the review: an approved task without a separate merge grant is refused as any other is (AC-17, M5-10).
pub fn check_merge_authority(a: &MergeAuthority) -> Result<(), MergeRefusal> {
    if !a.task.has_linked_repository {
        return Err(MergeRefusal::TaskNotLinked);
    }
    coding_work_allowed(a.request, a.link).map_err(|_| MergeRefusal::RepoNotReady)?;
    let repo_id = a.link_repo_id.ok_or(MergeRefusal::RepoNotReady)?;
    if !a.requester_connected {
        return Err(MergeRefusal::AgentDisconnected);
    }
    if a.requester == a.submitter || a.task.assignee.as_deref() == Some(a.requester) {
        return Err(MergeRefusal::SelfMerge);
    }
    check_grant(a.grant, GrantAction::Merge, repo_id, a.now).map_err(MergeRefusal::Grant)?;
    if !valid_commit_sha(a.commit_sha) {
        return Err(MergeRefusal::InvalidCommit);
    }
    let approved = a
        .task
        .approved_submission_no
        .filter(|_| a.task.status == TaskStatus::Completed)
        .ok_or(MergeRefusal::NotApproved)?;
    if approved != a.submission_no {
        return Err(MergeRefusal::SubmissionMismatch);
    }
    if a.task.submission_commit.as_deref() != Some(a.commit_sha) {
        return Err(MergeRefusal::CommitChanged);
    }
    Ok(())
}

/// A task's `task_change` row, as far as asking for a merge needs it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Change<'a> {
    pub provider_repo_id: i64,
    pub submission_no: u32,
    pub reviewed_commit_sha: Option<&'a str>,
    pub merge_state: MergeState,
    /// The reason code of the last failed merge.
    pub merge_reason: Option<&'a str>,
}

/// Decides `merge_task`: on success the change moves to `requested`, `merge.requested` is recorded and the merge job is
/// queued. Nothing merges here.
///
/// The head the room last observed isn't consulted. Observations can lag, so the job reads the pull request itself, and
/// a head that has moved ends as a recorded `merge.failed` with `commit_changed` (M5-09), with the task still completed.
/// A merge that failed for any other reason may be asked for again. One that failed with `commit_changed` may not: the
/// reviewed commit can't change on a completed task, so the changed code goes to a follow-up task.
pub fn decide_merge_request(
    authority: &MergeAuthority,
    change: Option<&Change>,
) -> Result<MergeState, MergeRefusal> {
    check_merge_authority(authority)?;
    let change = change
        .filter(|c| Some(c.provider_repo_id) == authority.link_repo_id)
        .ok_or(MergeRefusal::ChangeNotFound)?;
    if change.submission_no != authority.submission_no {
        return Err(MergeRefusal::SubmissionMismatch);
    }
    if change
        .reviewed_commit_sha
        .is_some_and(|sha| sha != authority.commit_sha)
    {
        return Err(MergeRefusal::CommitChanged);
    }
    if change.merge_state == MergeState::Failed
        && change.merge_reason == Some(MergeFailure::CommitChanged.code())
    {
        return Err(MergeRefusal::CommitChanged);
    }
    merge_transition(change.merge_state, MergeEvent::Requested).ok_or(match change.merge_state {
        MergeState::Succeeded => MergeRefusal::AlreadyMerged,
        MergeState::NotRequested | MergeState::Requested | MergeState::Failed => {
            MergeRefusal::AlreadyRequested
        }
    })
}

/// The three events of a merge.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MergeEvent {
    Requested,
    Succeeded,
    Failed,
}

impl MergeEvent {
    /// The event name in the API and inbox.
    pub fn name(self) -> &'static str {
        match self {
            MergeEvent::Requested => "merge.requested",
            MergeEvent::Succeeded => "merge.succeeded",
            MergeEvent::Failed => "merge.failed",
        }
    }
}

/// Where an event takes a change's merge state, or `None` when it can't happen from there. A merge is asked for from
/// `not_requested`, or again from `failed`. Only a requested merge succeeds or fails, and nothing leaves `succeeded`.
pub fn merge_transition(from: MergeState, event: MergeEvent) -> Option<MergeState> {
    match (from, event) {
        (MergeState::NotRequested | MergeState::Failed, MergeEvent::Requested) => {
            Some(MergeState::Requested)
        }
        (MergeState::Requested, MergeEvent::Succeeded) => Some(MergeState::Succeeded),
        (MergeState::Requested, MergeEvent::Failed) => Some(MergeState::Failed),
        _ => None,
    }
}

/// Why a requested merge failed. The task stays completed either way.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MergeFailure {
    /// `commit_changed`: the pull request's head isn't the reviewed commit.
    CommitChanged,
    /// `base_changed`: the pull request no longer targets the repository's default branch.
    BaseChanged,
    /// `head_repo_changed`: the pull request's head isn't in the room's repository, or its repository can't be read.
    HeadRepoChanged,
    /// `pull_request_closed`
    PullClosed,
    /// `provider_refused`: GitHub refused the merge, with its status code.
    ProviderRefused(u16),
    /// The job's recheck found the requester's authority gone, with that refusal's own code.
    AuthorityLost(MergeRefusal),
}

impl MergeFailure {
    pub fn code(self) -> &'static str {
        match self {
            MergeFailure::CommitChanged => "commit_changed",
            MergeFailure::BaseChanged => "base_changed",
            MergeFailure::HeadRepoChanged => "head_repo_changed",
            MergeFailure::PullClosed => "pull_request_closed",
            MergeFailure::ProviderRefused(_) => "provider_refused",
            MergeFailure::AuthorityLost(refusal) => refusal.code(),
        }
    }

    /// Whether the way on is a follow-up task with its own review, and not another `merge_task` (decision 25).
    pub fn needs_follow_up(self) -> bool {
        matches!(
            self,
            MergeFailure::CommitChanged | MergeFailure::AuthorityLost(MergeRefusal::CommitChanged)
        )
    }
}

/// A pull request's state as GitHub gives it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PullState {
    Open,
    Closed,
    Merged,
}

/// What the job just read from GitHub about the task's pull request. Nothing here is kept from an earlier read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PullObservation<'a> {
    pub state: PullState,
    pub base_ref: &'a str,
    pub base_sha: &'a str,
    /// `None` when the head's repository is gone or can't be read.
    pub head_repo_id: Option<i64>,
    pub head_sha: &'a str,
    /// Whether the default branch contains the reviewed commit, when the job has read that.
    pub default_branch_has_reviewed: Option<bool>,
}

/// The values the review is bound to, from the room's own rows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Reviewed<'a> {
    /// The approved submission's commit.
    pub commit_sha: &'a str,
    /// The base the review saw, when it was recorded.
    pub base_sha: Option<&'a str>,
    /// The linked repository and its default branch.
    pub repo_id: i64,
    pub default_branch: &'a str,
}

/// How GitHub answered the merge call, when this run of the job made one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MergeCall {
    /// `200`. Not proof of a merge: an already merged pull request answers the same.
    Accepted,
    /// `409`: the head isn't the `sha` the call named.
    HeadModified,
    /// Any other refusal, with its status code.
    Refused(u16),
    /// A timeout, or an answer that says nothing certain.
    Unknown,
}

/// What the merge job does next.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MergeStep<'a> {
    /// Mark this commit with the merge App's status and merge with it as `sha`, straight away. `base_moved` is recorded
    /// with the merge: `None` when no reviewed base was kept.
    MarkAndMerge {
        sha: &'a str,
        base_moved: Option<bool>,
    },
    /// Record `merge.succeeded`.
    Succeeded,
    /// Record `merge.failed` with this reason. Nothing is marked.
    Failed(MergeFailure),
    /// Nothing certain yet: read the pull request again later. The merge stays requested, and a later run starts from
    /// what it reads then.
    ReadAgain,
}

/// Decides the merge job's next step, after `check_merge_authority` has passed again. `call` is `None` before this run
/// has called GitHub's merge, and its answer after.
///
/// - A pull request that reads as merged succeeds only if its head is the reviewed commit, its base is the default
///   branch and the default branch is seen to contain that commit. A retried job therefore finds its earlier merge here
///   and never calls again.
/// - Before any mark, the base must be the default branch, the head must be in the linked repository and the head must
///   be the reviewed commit. Any difference fails the merge.
/// - A moved base doesn't fail a merge in M5. It's reported, to be recorded.
/// - After a call, GitHub's answer alone never succeeds: only the pull request's own state does.
pub fn decide_merge_step<'a>(
    reviewed: &Reviewed<'a>,
    observed: &PullObservation,
    call: Option<MergeCall>,
) -> MergeStep<'a> {
    if observed.base_ref != reviewed.default_branch {
        return MergeStep::Failed(MergeFailure::BaseChanged);
    }
    if observed.head_repo_id != Some(reviewed.repo_id) {
        return MergeStep::Failed(MergeFailure::HeadRepoChanged);
    }
    if observed.head_sha != reviewed.commit_sha {
        return MergeStep::Failed(MergeFailure::CommitChanged);
    }
    match (observed.state, call) {
        (PullState::Merged, _) if observed.default_branch_has_reviewed == Some(true) => {
            MergeStep::Succeeded
        }
        (PullState::Merged, _) => MergeStep::ReadAgain,
        (PullState::Closed, _) => MergeStep::Failed(MergeFailure::PullClosed),
        (PullState::Open, None) => MergeStep::MarkAndMerge {
            sha: reviewed.commit_sha,
            base_moved: reviewed.base_sha.map(|base| base != observed.base_sha),
        },
        (PullState::Open, Some(MergeCall::HeadModified)) => {
            MergeStep::Failed(MergeFailure::CommitChanged)
        }
        (PullState::Open, Some(MergeCall::Refused(status))) => {
            MergeStep::Failed(MergeFailure::ProviderRefused(status))
        }
        (PullState::Open, Some(MergeCall::Accepted | MergeCall::Unknown)) => MergeStep::ReadAgain,
    }
}

/// A merge Podster read from GitHub on a linked pull request, against what it had asked for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ObservedMerge {
    /// The merge Podster asked for, of the reviewed commit.
    Requested,
    /// `unrequested_merge`: the reviewed commit, with no merge asked for through Podster.
    Unrequested,
    /// `unreviewed_merge`: a commit that isn't an approved submission's.
    Unreviewed,
}

impl ObservedMerge {
    /// The reason code recorded with a merge Podster didn't make, for the room's owner and the operators.
    pub fn reason(self) -> Option<&'static str> {
        match self {
            ObservedMerge::Requested => None,
            ObservedMerge::Unrequested => Some("unrequested_merge"),
            ObservedMerge::Unreviewed => Some("unreviewed_merge"),
        }
    }
}

/// Classifies a merge GitHub shows. GitHub is the source of truth for what merged, so every one is recorded, and
/// Podster reverts none. `reviewed_commit_sha` is the approved submission's commit, or `None` if nothing was approved.
pub fn classify_observed_merge(
    merge_state: MergeState,
    merged_head_sha: &str,
    reviewed_commit_sha: Option<&str>,
) -> ObservedMerge {
    if reviewed_commit_sha != Some(merged_head_sha) {
        return ObservedMerge::Unreviewed;
    }
    match merge_state {
        MergeState::Requested | MergeState::Succeeded => ObservedMerge::Requested,
        MergeState::NotRequested | MergeState::Failed => ObservedMerge::Unrequested,
    }
}
