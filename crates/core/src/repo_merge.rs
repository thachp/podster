//! Merge as its own state: asking for one, what the merge job does next, and how it ends (ADR 0009, which is proposed). No I/O.
//!
//! Approval and merge are two events, never one state. Approving a task completes it and merges nothing (AC-17). A merge
//! is asked for separately, by someone who holds a `merge` grant that counts and isn't controlled by the person who
//! controls the submitter, and it names the approved submission and its commit.
//!
//! GitHub's rules know nothing of a review, so what was reviewed is decided here, before the merge App marks anything.
//! The job reads the pull request itself each time and takes nothing from an earlier read, because an agent's token can
//! edit a pull request. Success is only ever read from the pull request's own state: a second merge call answers `200`.
//!
//! Two proof values keep that order. [`check_merge_authority`] alone makes a [`MergeAuthorized`], which
//! [`decide_merge_step`] needs. [`decide_merge_step`] alone makes a [`MergeObserved`], which the move to `succeeded`
//! needs. So no success is recorded without the recheck of authority and a read of GitHub behind it.
//!
//! **Run `podster_policy::repositories::authorize_merge` first.** It decides whether the caller may know the task
//! exists. [`check_merge_authority`] answers `task_not_linked` and `repo_not_ready` before it looks at the grant, so run
//! alone it would tell a caller who can't see the task something about it.

use crate::repo_grants::{check_grant, Grant, GrantRefusal, GrantUse};
use crate::repositories::{
    coding_work_allowed, valid_commit_sha, GrantAction, LinkStatus, MergeState, RequestState,
};
use crate::{Task, TaskStatus};

/// Someone acting on a task, with the person who controls them: a person is their own, and an agent's is the person who
/// owns it. `None` when the room can't say who that is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Actor<'a> {
    pub id: &'a str,
    pub person: Option<&'a str>,
}

/// Whether two actors answer to the same person, or can't be shown not to. The same principal does, and so do an agent
/// and its owner, and two agents of one owner. An actor whose controlling person is unknown counts as the same as
/// anyone, so the rule fails closed.
pub fn same_controller(a: &Actor, b: &Actor) -> bool {
    a.id == b.id
        || match (a.person, b.person) {
            (Some(one), Some(other)) => one == other,
            _ => true,
        }
}

/// Why a merge wasn't asked for, or why the job's recheck of authority stopped it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MergeRefusal {
    /// `access_revoked`: whoever asked is no longer in the room.
    AccessRevoked,
    /// `agent_disconnected`: an agent asked, and its connection no longer holds.
    AgentDisconnected,
    /// `controller_departed`: the person who controls whoever asked, an agent's linker or a person themselves, has left
    /// the organization they're in the room through since the merge was asked for, or the room can't name them.
    ControllerDeparted,
    /// `task_not_found`: whoever asked can no longer see the task.
    TaskHidden,
    /// `public_participant`: whoever asked is in the room through a public claim now.
    PublicParticipant,
    /// `not_allowed`: whoever asked may no longer ask for this, for a reason the policy names no better.
    NotAllowed,
    /// `task_not_linked`: the task has no linked repository.
    TaskNotLinked,
    /// `repo_not_ready`
    RepoNotReady,
    /// `self_merge`: nobody merges work that the person controlling them also controls the submitter of, with a grant or
    /// without.
    SelfMerge,
    /// `grant_required`, `grant_expired` or `grant_stale`
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
    /// `review_required`: the approval recorded no reviewed commit, as one made while managed repositories were off
    /// doesn't. Nothing was read from the provider for it, so it needs a fresh review.
    ReviewRequired,
    /// `change_unwatched`: the task's pull request kept answering as not there, and Podster stopped reading it.
    ChangeUnwatched,
}

impl MergeRefusal {
    pub fn code(self) -> &'static str {
        match self {
            MergeRefusal::AccessRevoked => "access_revoked",
            MergeRefusal::AgentDisconnected => "agent_disconnected",
            MergeRefusal::ControllerDeparted => "controller_departed",
            MergeRefusal::TaskHidden => "task_not_found",
            MergeRefusal::PublicParticipant => "public_participant",
            MergeRefusal::NotAllowed => "not_allowed",
            MergeRefusal::TaskNotLinked => "task_not_linked",
            MergeRefusal::RepoNotReady => "repo_not_ready",
            MergeRefusal::SelfMerge => "self_merge",
            MergeRefusal::Grant(refusal) => refusal.code(),
            MergeRefusal::InvalidCommit => "invalid_argument",
            MergeRefusal::NotApproved => "not_approved",
            MergeRefusal::SubmissionMismatch => "submission_mismatch",
            MergeRefusal::CommitChanged => "commit_changed",
            MergeRefusal::ChangeNotFound => "change_not_found",
            MergeRefusal::AlreadyRequested => "merge_already_requested",
            MergeRefusal::AlreadyMerged => "already_merged",
            MergeRefusal::ReviewRequired => "review_required",
            MergeRefusal::ChangeUnwatched => "change_unwatched",
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
    pub requester: Actor<'a>,
    /// The requester is a current participant of the room, and hasn't been removed or left since asking.
    pub requester_in_room: bool,
    /// For an agent, whether its connection holds now. Always true for a person.
    pub requester_connected: bool,
    /// The person who controls the requester, an agent's linker or a person themselves, is still in the organization
    /// the requester is in the room through. An agent acts for that person, so once they've left it merges nothing, as a
    /// token is refused then (`repo_access::AccessCheck::controller_holds`).
    pub requester_controller_holds: bool,
    /// Who made the submission that was approved, from the submission's own row.
    pub submitter: Actor<'a>,
    /// The requester's `merge` grant row that isn't revoked, if any.
    pub grant: Option<&'a Grant<'a>>,
    /// The grant's giver, if they still hold authority over the room's repository: see [`GrantUse::delegation_holder`].
    pub delegation_holder: Option<&'a str>,
    /// The submission and commit the request names.
    pub submission_no: u32,
    pub commit_sha: &'a str,
    pub now: i64,
}

/// The approved submission's commit: the one a merge may name. `None` unless the task is completed with an approved
/// submission that recorded a commit.
pub fn approved_commit(task: &Task) -> Option<&str> {
    task.approved_submission_no
        .filter(|_| task.status == TaskStatus::Completed)
        .and(task.submission_commit.as_deref())
}

/// Proof that [`check_merge_authority`] passed for one task's reviewed commit on the room's repository. Its fields are
/// private, so nothing else can make one, and the merge job can't decide a step without it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MergeAuthorized {
    task_id: String,
    repo_id: i64,
    commit_sha: String,
}

impl MergeAuthorized {
    /// The authorization a merge call was made under, rebuilt from the room's record of that call, for reading what
    /// became of it. Only for a change whose call is on record: the transaction that recorded the intent to call ran
    /// [`check_merge_authority`] on the rows as they were then, and the call named this commit. It lets a later pass ask
    /// [`decide_merge_step`] whether that call merged, even if authority has ended since. It never justifies a new
    /// mark or a new call, which need a fresh [`check_merge_authority`].
    pub fn when_called(task_id: &str, repo_id: i64, commit_sha: &str) -> MergeAuthorized {
        MergeAuthorized {
            task_id: task_id.to_string(),
            repo_id,
            commit_sha: commit_sha.to_string(),
        }
    }

    pub fn task_id(&self) -> &str {
        &self.task_id
    }

    /// The room's linked repository.
    pub fn repo_id(&self) -> i64 {
        self.repo_id
    }

    /// The approved submission's commit.
    pub fn commit_sha(&self) -> &str {
        &self.commit_sha
    }
}

/// Checks the authority for a merge. Who is asking comes first, then the grant, and the task's review last, so a caller
/// with no grant learns nothing about the review: an approved task without a separate merge grant is refused as any
/// other is (AC-17, M5-10).
///
/// The caller must have passed `podster_policy::repositories::authorize_merge` first, since `task_not_linked` and
/// `repo_not_ready` are answered here before the grant is looked at.
///
/// The submitter rule compares controlling people, not IDs: the submitting agent's owner and that owner's other agents
/// are refused as the submitter is. A reviewer may merge what they approved only if a different person controls them.
pub fn check_merge_authority(a: &MergeAuthority) -> Result<MergeAuthorized, MergeRefusal> {
    if !a.requester_in_room {
        return Err(MergeRefusal::AccessRevoked);
    }
    if !a.requester_connected {
        return Err(MergeRefusal::AgentDisconnected);
    }
    if !a.requester_controller_holds {
        return Err(MergeRefusal::ControllerDeparted);
    }
    if !a.task.has_linked_repository {
        return Err(MergeRefusal::TaskNotLinked);
    }
    coding_work_allowed(a.request, a.link).map_err(|_| MergeRefusal::RepoNotReady)?;
    let repo_id = a.link_repo_id.ok_or(MergeRefusal::RepoNotReady)?;
    if same_controller(&a.requester, &a.submitter)
        || a.task.assignee.as_deref() == Some(a.requester.id)
    {
        return Err(MergeRefusal::SelfMerge);
    }
    let usage = GrantUse {
        principal: a.requester.id,
        action: GrantAction::Merge,
        link_repo_id: repo_id,
        delegation_holder: a.delegation_holder,
        now: a.now,
    };
    check_grant(a.grant, &usage).map_err(MergeRefusal::Grant)?;
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
    if approved_commit(a.task) != Some(a.commit_sha) {
        return Err(MergeRefusal::CommitChanged);
    }
    Ok(MergeAuthorized {
        task_id: a.task.id.clone(),
        repo_id,
        commit_sha: a.commit_sha.to_string(),
    })
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
///
/// The change's own reviewed commit may be missing, when no step has written it yet. The commit is then bound by the
/// task's approved submission alone, which [`check_merge_authority`] has already compared.
pub fn decide_merge_request(
    authority: &MergeAuthority,
    change: Option<&Change>,
) -> Result<MergeState, MergeRefusal> {
    let authorized = check_merge_authority(authority)?;
    let change = change
        .filter(|c| c.provider_repo_id == authorized.repo_id)
        .ok_or(MergeRefusal::ChangeNotFound)?;
    if change.submission_no != authority.submission_no {
        return Err(MergeRefusal::SubmissionMismatch);
    }
    if change
        .reviewed_commit_sha
        .is_some_and(|sha| sha != authorized.commit_sha)
    {
        return Err(MergeRefusal::CommitChanged);
    }
    match change.merge_state {
        MergeState::Failed if change.merge_reason == Some(MergeFailure::CommitChanged.code()) => {
            Err(MergeRefusal::CommitChanged)
        }
        MergeState::NotRequested | MergeState::Failed => Ok(MergeState::Requested),
        // One whose outcome isn't known yet is still under way: the job is reading until it knows.
        MergeState::Requested | MergeState::OutcomeUnknown => Err(MergeRefusal::AlreadyRequested),
        MergeState::Succeeded => Err(MergeRefusal::AlreadyMerged),
    }
}

/// Proof that the task's pull request was read as merged at the reviewed commit, with the default branch holding it,
/// under an authority that had just been rechecked. Only [`decide_merge_step`] makes one, and a merge can't move to
/// `succeeded` without it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MergeObserved {
    task_id: String,
    commit_sha: String,
}

impl MergeObserved {
    pub fn task_id(&self) -> &str {
        &self.task_id
    }

    /// The commit that merged, which is the approved submission's.
    pub fn commit_sha(&self) -> &str {
        &self.commit_sha
    }
}

/// The three events of a merge.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MergeEvent {
    Requested,
    /// Carries the observation it rests on.
    Succeeded(MergeObserved),
    Failed,
    /// A merge call went out, the merge was about to end, and the provider couldn't be read to see what the call did.
    OutcomeUnknown,
}

impl MergeEvent {
    /// The event name in the API and inbox.
    pub fn name(&self) -> &'static str {
        match self {
            MergeEvent::Requested => "merge.requested",
            MergeEvent::Succeeded(_) => "merge.succeeded",
            MergeEvent::Failed => "merge.failed",
            MergeEvent::OutcomeUnknown => "merge.outcome_unknown",
        }
    }
}

/// Where an event takes the merge state of `task_id`'s change, or `None` when it can't happen from there. A merge is
/// asked for from `not_requested`, or again from `failed`. Only a requested merge succeeds or fails, and nothing leaves
/// `succeeded`. Success needs an observation of this same task: one made for another task moves nothing.
pub fn merge_transition(task_id: &str, from: MergeState, event: &MergeEvent) -> Option<MergeState> {
    match (from, event) {
        (MergeState::NotRequested | MergeState::Failed, MergeEvent::Requested) => {
            Some(MergeState::Requested)
        }
        (MergeState::Requested | MergeState::OutcomeUnknown, MergeEvent::Succeeded(seen))
            if seen.task_id == task_id =>
        {
            Some(MergeState::Succeeded)
        }
        (MergeState::Requested | MergeState::OutcomeUnknown, MergeEvent::Failed) => {
            Some(MergeState::Failed)
        }
        (MergeState::Requested, MergeEvent::OutcomeUnknown) => Some(MergeState::OutcomeUnknown),
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
    /// `pull_request_draft`: it went back to a draft after review. A draft can't be merged.
    PullDraft,
    /// `merged_elsewhere`: the pull request was already merged when the job first read it, before the job had asked the
    /// provider for anything. That merge isn't this request's, whatever commit it was of.
    MergedElsewhere,
    /// `repo_not_ready`: the repository's protections, read back before the merge, aren't what provisioning set.
    NotReady,
    /// `merge_attempts_exhausted`: the job ran its last allowed pass without an outcome. A person asks again.
    AttemptsExhausted,
    /// `workspace_archived`: the room was archived after the merge was asked for. Nothing is done in an archived room.
    RoomArchived,
    /// `room_suspended`: an operator suspended the room after the merge was asked for.
    RoomSuspended,
    /// `default_branch_changed`: the repository's default branch on the provider isn't the one the room's link holds.
    /// The rules protect whichever branch is the default now, so nothing is merged into either.
    DefaultBranchChanged,
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
            MergeFailure::PullDraft => "pull_request_draft",
            MergeFailure::MergedElsewhere => "merged_elsewhere",
            MergeFailure::NotReady => "repo_not_ready",
            MergeFailure::AttemptsExhausted => "merge_attempts_exhausted",
            MergeFailure::RoomArchived => "workspace_archived",
            MergeFailure::RoomSuspended => "room_suspended",
            MergeFailure::DefaultBranchChanged => "default_branch_changed",
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

/// Where the reviewed commit was to merge, from the room's own rows. The commit and the repository themselves come
/// from the [`MergeAuthorized`] proof.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReviewedBase<'a> {
    /// The linked repository's default branch.
    pub default_branch: &'a str,
    /// The base the review saw, when it was recorded.
    pub base_sha: Option<&'a str>,
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
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MergeStep {
    /// Mark this commit with the merge App's status and merge with it as `sha`, straight away. `base_moved` is recorded
    /// with the merge: `None` when no reviewed base was kept.
    MarkAndMerge {
        sha: String,
        base_moved: Option<bool>,
    },
    /// Record `merge.succeeded`, with the proof that [`merge_transition`] needs.
    Succeeded(MergeObserved),
    /// Record `merge.failed` with this reason. Nothing is marked.
    Failed(MergeFailure),
    /// Nothing certain yet: read the pull request again later. The merge stays requested, and a later run starts from
    /// what it reads then.
    ReadAgain,
}

/// Decides the merge job's next step. It needs the proof that [`check_merge_authority`] passed again in this run, and
/// takes the reviewed commit and the repository from that proof. `call` is `None` before this run has called GitHub's
/// merge, and its answer after.
///
/// - A pull request that reads as merged succeeds only if its head is the reviewed commit, its base is the default
///   branch and the default branch is seen to contain that commit. A retried job therefore finds its earlier merge here
///   and never calls again.
/// - Before any mark, the base must be the default branch, the head must be in the linked repository and the head must
///   be the reviewed commit. Any difference fails the merge.
/// - A moved base doesn't fail a merge in M5. It's reported, to be recorded.
/// - After a call, GitHub's answer alone never succeeds: only the pull request's own state does.
pub fn decide_merge_step(
    authorized: &MergeAuthorized,
    reviewed: &ReviewedBase,
    observed: &PullObservation,
    call: Option<MergeCall>,
) -> MergeStep {
    if observed.base_ref != reviewed.default_branch {
        return MergeStep::Failed(MergeFailure::BaseChanged);
    }
    if observed.head_repo_id != Some(authorized.repo_id) {
        return MergeStep::Failed(MergeFailure::HeadRepoChanged);
    }
    if observed.head_sha != authorized.commit_sha {
        return MergeStep::Failed(MergeFailure::CommitChanged);
    }
    match (observed.state, call) {
        (PullState::Merged, _) if observed.default_branch_has_reviewed == Some(true) => {
            MergeStep::Succeeded(MergeObserved {
                task_id: authorized.task_id.clone(),
                commit_sha: authorized.commit_sha.clone(),
            })
        }
        (PullState::Merged, _) => MergeStep::ReadAgain,
        (PullState::Closed, _) => MergeStep::Failed(MergeFailure::PullClosed),
        (PullState::Open, None) => MergeStep::MarkAndMerge {
            sha: authorized.commit_sha.clone(),
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

/// Classifies a merge GitHub shows on a task's pull request. GitHub is the source of truth for what merged, so every
/// one is recorded, and Podster reverts none. The approved commit is read from the task itself, through
/// [`approved_commit`], never handed in: a task that isn't completed, or whose approved submission recorded no commit,
/// has none, and any merge on it is unreviewed.
///
/// This names a merge. It never moves a merge to `succeeded`, which only [`MergeObserved`] does.
pub fn classify_observed_merge(
    task: &Task,
    merge_state: MergeState,
    merged_head_sha: &str,
) -> ObservedMerge {
    if approved_commit(task) != Some(merged_head_sha) {
        return ObservedMerge::Unreviewed;
    }
    match merge_state {
        MergeState::Requested | MergeState::Succeeded | MergeState::OutcomeUnknown => {
            ObservedMerge::Requested
        }
        MergeState::NotRequested | MergeState::Failed => ObservedMerge::Unrequested,
    }
}

/// How many passes the merge job makes at one request before it gives up. Proposed.
pub const MAX_MERGE_ATTEMPTS: u32 = 5;
/// How many merge requests one room takes in an hour, counting every request, a repeated one included. Proposed.
pub const MAX_MERGE_REQUESTS_PER_HOUR: u32 = 20;
/// How many merge requests one task takes in its whole life. Asking again never resets it. Proposed.
pub const MAX_MERGE_REQUESTS_PER_TASK: u32 = 10;

/// Why a merge can't be asked for just now, by count alone.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RequestLimit {
    /// `rate_limited`: the room has had its requests for this hour.
    Room,
    /// `merge_request_limit`: this task has had every merge request it will ever get.
    Task,
}

impl RequestLimit {
    pub fn code(self) -> &'static str {
        match self {
            RequestLimit::Room => "rate_limited",
            RequestLimit::Task => "merge_request_limit",
        }
    }
}

/// Whether another merge may be asked for, given how many requests this task has ever had and how many the room had
/// in the last hour. The task's own limit is said first: waiting an hour doesn't lift it.
pub fn merge_request_allowed(
    room_requests_in_last_hour: u32,
    task_requests_ever: u32,
) -> Result<(), RequestLimit> {
    if task_requests_ever >= MAX_MERGE_REQUESTS_PER_TASK {
        Err(RequestLimit::Task)
    } else if room_requests_in_last_hour >= MAX_MERGE_REQUESTS_PER_HOUR {
        Err(RequestLimit::Room)
    } else {
        Ok(())
    }
}

/// Whether the job may make another pass, having made this many.
pub fn merge_attempt_allowed(attempts_made: u32) -> bool {
    attempts_made < MAX_MERGE_ATTEMPTS
}

/// What the room holds of a task's change that a merge depends on beyond [`Change`]: what review recorded, and what
/// Podster's own reads have shown since (M5 step 7a).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChangeStanding<'a> {
    /// The commit recorded by an approval made from a read of the provider. `None` for an approval made while managed
    /// repositories were off.
    pub reviewed_commit_sha: Option<&'a str>,
    /// The head has been seen off the reviewed commit, at any time since review, even if it was put back.
    pub commit_changed: bool,
    /// Podster is still reading the pull request.
    pub watched: bool,
}

/// Whether the task's change still stands as reviewed, for the commit the merge names. Asked when a merge is requested
/// and again by the job. A changed commit is never merged, even if the branch is put back (plan decision 6): the way
/// on is a follow-up task.
pub fn check_change_standing(
    standing: &ChangeStanding,
    commit_sha: &str,
) -> Result<(), MergeRefusal> {
    let reviewed = standing
        .reviewed_commit_sha
        .ok_or(MergeRefusal::ReviewRequired)?;
    if reviewed != commit_sha || standing.commit_changed {
        return Err(MergeRefusal::CommitChanged);
    }
    if !standing.watched {
        return Err(MergeRefusal::ChangeUnwatched);
    }
    Ok(())
}

/// What the provider's answer to the merge call says, by its status. It never says the merge happened: only a read of
/// the pull request and the default branch does, through [`decide_merge_step`]. No answer, or a server error, is unknown.
pub fn merge_call(status: Option<u16>) -> MergeCall {
    match status {
        Some(200) => MergeCall::Accepted,
        Some(409) => MergeCall::HeadModified,
        None | Some(500..=599) => MergeCall::Unknown,
        Some(other) => MergeCall::Refused(other),
    }
}

/// How many times the job reads again for a merge whose outcome isn't known, before it stops. Proposed.
pub const MAX_UNKNOWN_READS: u32 = 12;
const UNKNOWN_READ_MIN_MS: i64 = 15 * 60 * 1000;
const UNKNOWN_READ_MAX_MS: i64 = 6 * 60 * 60 * 1000;

/// How long to wait before the next read of a merge whose outcome isn't known, having tried this many times: fifteen
/// minutes, doubling to six hours. Proposed.
pub fn unknown_read_wait_ms(reads_made: u32) -> i64 {
    UNKNOWN_READ_MIN_MS
        .checked_shl(reads_made.min(16))
        .map_or(UNKNOWN_READ_MAX_MS, |wait| {
            wait.clamp(UNKNOWN_READ_MIN_MS, UNKNOWN_READ_MAX_MS)
        })
}

/// Whether the job reads again for a merge whose outcome isn't known. Never in a room that's archived or suspended,
/// and not past the cap. After that the outcome stays recorded as unknown until a person asks for the merge again,
/// which begins with a read.
pub fn unknown_read_allowed(reads_made: u32, room_open: bool) -> bool {
    room_open && reads_made < MAX_UNKNOWN_READS
}

/// What a read made after a merge call was recorded says became of that call.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Landed {
    /// The pull request reads as merged, with the reviewed commit, and the default branch holds it. The proof moves
    /// the merge to succeeded. `default_branch_differs` says the provider's default branch isn't the link's any more:
    /// the merge is still recorded as the merge it was, and the link is degraded so nothing more is merged.
    Merged {
        proof: MergeObserved,
        default_branch_differs: bool,
    },
    /// The pull request reads as merged and the provider's default branch couldn't be read. Nothing is recorded
    /// without that comparison: read again.
    DefaultBranchUnread,
    /// It didn't land as this request's merge. The step says what the read comes to otherwise.
    No(MergeStep),
}

/// Decides what a read made after a recorded merge call means. The one decision for every place that asks, so the
/// pass that made the call and a later pass that only reads can't come to different answers.
pub fn decide_landed(
    authorized: &MergeAuthorized,
    reviewed: &ReviewedBase,
    observed: &PullObservation,
    call: Option<MergeCall>,
    reported_default_branch: Option<&str>,
) -> Landed {
    let step = decide_merge_step(authorized, reviewed, observed, call);
    if observed.state != PullState::Merged {
        return Landed::No(step);
    }
    match (step, reported_default_branch) {
        (MergeStep::Succeeded(_), None) => Landed::DefaultBranchUnread,
        (MergeStep::Succeeded(proof), Some(reported)) => Landed::Merged {
            proof,
            default_branch_differs: reported != reviewed.default_branch,
        },
        (other, _) => Landed::No(other),
    }
}

/// The state a new merge request is decided from. A merge whose outcome the job has stopped reading for may be asked
/// for again, as a failed one may: that request's first pass begins with a read. While the job is still reading, it
/// may not.
pub fn requestable_state(state: MergeState, unknown_reads_ended: bool) -> MergeState {
    match state {
        MergeState::OutcomeUnknown if unknown_reads_ended => MergeState::Failed,
        other => other,
    }
}

/// How the ordinary watch of a task's change settles a merge whose outcome isn't known.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WatchSettles {
    /// The pull request is merged with the reviewed commit as its head, into the default branch, and the provider's
    /// default branch is the link's.
    Merged(MergeObserved),
    /// The pull request is closed and not merged, or merged at another commit or into another branch: the recorded
    /// call didn't merge the reviewed commit.
    Failed,
    /// It reads as merged, and the provider's default branch isn't the link's. The watch doesn't record a merge into a
    /// branch that isn't the default the provider reports: the link is degraded, and the merge job's own read, or a
    /// new request, decides, with [`decide_landed`].
    DefaultBranchDiffers,
    /// Still open, or not enough read to say, such as a default branch the answer didn't name.
    NotYet,
}

/// Decides, from the watch's own read of the pull request, what became of a merge call whose outcome is unknown,
/// whether the job is still reading for it or has stopped. It's [`decide_landed`] on what that one read carries: "the
/// default branch holds the commit" is the pull request saying it merged into its base, with that base being the
/// link's default branch, and the provider's default branch is the one the pull request's own answer names for its
/// repository. No call is made and nothing more is read for this.
pub fn settle_unknown_from_watch(
    authorized: &MergeAuthorized,
    reviewed: &ReviewedBase,
    observed: &PullObservation,
    reported_default_branch: Option<&str>,
) -> WatchSettles {
    if observed.state == PullState::Open {
        return WatchSettles::NotYet;
    }
    let observed = PullObservation {
        default_branch_has_reviewed: Some(
            observed.state == PullState::Merged && observed.base_ref == reviewed.default_branch,
        ),
        ..*observed
    };
    match decide_landed(
        authorized,
        reviewed,
        &observed,
        None,
        reported_default_branch,
    ) {
        Landed::Merged {
            proof,
            default_branch_differs: false,
        } => WatchSettles::Merged(proof),
        Landed::Merged { .. } => WatchSettles::DefaultBranchDiffers,
        Landed::DefaultBranchUnread | Landed::No(MergeStep::ReadAgain) => WatchSettles::NotYet,
        Landed::No(_) => WatchSettles::Failed,
    }
}
