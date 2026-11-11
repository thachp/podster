//! Managed repositories: the states a room keeps for M5 (ADR 0009, which is proposed). No I/O.
//!
//! M5 step 2 added the names of those states and the one rule every later step leans on: a repository lets a token be
//! issued or a merge run only while its link is `ready`. Step 3 adds what blocks coding work in a room, the rules for a
//! retried setup, and what a repository may be called. Grants are in `repo_grants`, the merge in `repo_merge` and an
//! agent's token in `repo_access`. Commit pinning on `submit_task` and `verify_task` is in `decide`. No route calls any
//! of it yet.
//!
//! A repository is known by the provider's repository ID, never by its name. Nothing here takes an organization, an
//! installation, a repository or a pull request from a caller: those come from the room's own rows and from configuration.

/// Where a room's request for a repository stands. One room has at most one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequestState {
    /// Recorded, and the provisioning job hasn't finished.
    Pending,
    /// The repository was created and everything readiness needs was read back.
    Ready,
    /// Setup failed, with a reason code. Nothing is deleted, and nothing falls back to another organization.
    Failed,
    /// The creation call's answer was lost, so no repository ID is held. Treated as a failed setup: nothing is adopted by name.
    Uncertain,
}

impl RequestState {
    pub fn name(self) -> &'static str {
        match self {
            RequestState::Pending => "pending",
            RequestState::Ready => "ready",
            RequestState::Failed => "failed",
            RequestState::Uncertain => "uncertain",
        }
    }

    pub fn from_name(name: &str) -> Option<RequestState> {
        [
            RequestState::Pending,
            RequestState::Ready,
            RequestState::Failed,
            RequestState::Uncertain,
        ]
        .into_iter()
        .find(|s| s.name() == name)
    }
}

/// Where a room's linked repository stands, once it has one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkStatus {
    Ready,
    /// A read-back found the repository's rules or settings differ from what readiness needs.
    Degraded,
    /// An operator's takedown.
    Suspended,
}

impl LinkStatus {
    pub fn name(self) -> &'static str {
        match self {
            LinkStatus::Ready => "ready",
            LinkStatus::Degraded => "degraded",
            LinkStatus::Suspended => "suspended",
        }
    }

    pub fn from_name(name: &str) -> Option<LinkStatus> {
        [
            LinkStatus::Ready,
            LinkStatus::Degraded,
            LinkStatus::Suspended,
        ]
        .into_iter()
        .find(|s| s.name() == name)
    }
}

/// A repository's own visibility, chosen at setup. It never follows the room's.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RepoVisibility {
    Public,
    Private,
}

impl RepoVisibility {
    pub fn name(self) -> &'static str {
        match self {
            RepoVisibility::Public => "public",
            RepoVisibility::Private => "private",
        }
    }

    pub fn from_name(name: &str) -> Option<RepoVisibility> {
        [RepoVisibility::Public, RepoVisibility::Private]
            .into_iter()
            .find(|v| v.name() == name)
    }
}

/// What a `provider_grant` lets its holder do on one repository. Each action is its own grant.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GrantAction {
    /// Task branches and pull requests.
    Push,
    /// Asking for the merge of an approved submission's commit. Approval alone never carries it.
    Merge,
}

impl GrantAction {
    pub fn name(self) -> &'static str {
        match self {
            GrantAction::Push => "push",
            GrantAction::Merge => "merge",
        }
    }

    pub fn from_name(name: &str) -> Option<GrantAction> {
        [GrantAction::Push, GrantAction::Merge]
            .into_iter()
            .find(|a| a.name() == name)
    }
}

/// Where the merge of a task's change stands. Approval and merge are two events, never one state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MergeState {
    NotRequested,
    Requested,
    Succeeded,
    /// A visible state of a completed task, with a reason code such as `commit_changed`.
    Failed,
    /// A merge call went out and what it did couldn't be read. Nothing more is asked of the provider but reads, which
    /// go on until one settles it as succeeded or failed.
    OutcomeUnknown,
}

impl MergeState {
    pub fn name(self) -> &'static str {
        match self {
            MergeState::NotRequested => "not_requested",
            MergeState::Requested => "requested",
            MergeState::Succeeded => "succeeded",
            MergeState::Failed => "failed",
            MergeState::OutcomeUnknown => "outcome_unknown",
        }
    }

    pub fn from_name(name: &str) -> Option<MergeState> {
        [
            MergeState::NotRequested,
            MergeState::Requested,
            MergeState::Succeeded,
            MergeState::Failed,
            MergeState::OutcomeUnknown,
        ]
        .into_iter()
        .find(|s| s.name() == name)
    }
}

/// Whether a token may be issued or a merge run. Only a `ready` link allows either: no link, a degraded one and a
/// suspended one all refuse, and so does a status this code can't read, which the caller passes as `None`.
pub fn link_allows_work(link: Option<LinkStatus>) -> bool {
    link == Some(LinkStatus::Ready)
}

/// Whether this is a full commit ID as written in hex: 40 lower-case digits, or 64 for a SHA-256 repository. An
/// abbreviated ID, a branch name or a tag never names a reviewed commit.
pub fn valid_commit_sha(sha: &str) -> bool {
    matches!(sha.len(), 40 | 64) && sha.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Whether a submission or an approval on a linked task names a commit: one is given, and it's a full commit ID.
pub fn names_commit(sha: &Option<String>) -> bool {
    sha.as_deref().is_some_and(valid_commit_sha)
}

/// Why coding work in a room can't go on. Every one answers `repo_not_ready`, and `reason` says which, for the room's
/// people. Nothing here blocks a task that has no linked repository.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkBlock {
    /// The room never asked for a repository, or its rows can't be read.
    NoRepository,
    SetupPending,
    SetupFailed,
    /// A creation call's answer was lost. It blocks exactly as a failed setup does.
    SetupUncertain,
    Degraded,
    Suspended,
}

impl WorkBlock {
    // codes: errors
    pub fn code(self) -> &'static str {
        "repo_not_ready"
    }

    pub fn reason(self) -> &'static str {
        match self {
            WorkBlock::NoRepository => "no_repository",
            WorkBlock::SetupPending => "setup_pending",
            WorkBlock::SetupFailed => "setup_failed",
            WorkBlock::SetupUncertain => "setup_uncertain",
            WorkBlock::Degraded => "degraded",
            WorkBlock::Suspended => "suspended",
        }
    }
}

/// Whether the room's repository lets coding work go on: a token issued, or a merge run. Only a `ready` link does. With
/// no link, the request says why. A request that reads `ready` with no link beside it is refused too, since the link is
/// what holds the repository's ID. Pass `None` for a row that's missing or a state this code can't read.
pub fn coding_work_allowed(
    request: Option<RequestState>,
    link: Option<LinkStatus>,
) -> Result<(), WorkBlock> {
    match (link, request) {
        (Some(LinkStatus::Ready), _) => Ok(()),
        (Some(LinkStatus::Degraded), _) => Err(WorkBlock::Degraded),
        (Some(LinkStatus::Suspended), _) => Err(WorkBlock::Suspended),
        (None, Some(RequestState::Pending)) => Err(WorkBlock::SetupPending),
        (None, Some(RequestState::Failed)) => Err(WorkBlock::SetupFailed),
        (None, Some(RequestState::Uncertain)) => Err(WorkBlock::SetupUncertain),
        (None, Some(RequestState::Ready) | None) => Err(WorkBlock::NoRepository),
    }
}

/// What blocks this task, if anything. A failed or uncertain setup blocks the room's coding tasks and nothing else
/// (M5-15), so a task with no linked repository is never blocked, whatever state the repository is in.
pub fn task_block(
    has_linked_repository: bool,
    request: Option<RequestState>,
    link: Option<LinkStatus>,
) -> Option<WorkBlock> {
    if !has_linked_repository {
        return None;
    }
    coding_work_allowed(request, link).err()
}

/// The longest name a managed repository may have, in bytes.
pub const MAX_REPO_NAME_BYTES: usize = 64;

/// Whether a repository may be called this: lower-case letters, digits and hyphens, starting with a letter or a digit,
/// at most 64 bytes. No dots, so a name GitHub treats specially in an organization, such as `.github`, can't be asked for.
pub fn valid_repo_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    let starts_well = bytes
        .next()
        .is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit());
    starts_well
        && name.len() <= MAX_REPO_NAME_BYTES
        && bytes.all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// How a retried setup goes on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RetryPlan {
    /// Podster holds the repository's ID from GitHub's own answer, so setup finishes on that repository. Nothing new is made.
    ResumeHeldRepository,
    /// No ID is held, so a creation call goes out under the new name. A repository an earlier call may have made stays
    /// where it is, unlinked.
    CreateUnderNewName,
}

/// Why a setup can't be retried.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RetryRefusal {
    /// `repo_request_not_found`: the room has no request, or its state can't be read.
    NoRequest,
    /// `setup_in_progress`
    InProgress,
    /// `already_ready`
    AlreadyReady,
    /// `invalid_argument`: no new name was supplied, or it isn't one a repository may have.
    InvalidName,
    /// `name_reused`: the new name is one an earlier attempt sent. A retry never goes back to a name, because a repository
    /// by that name may exist and would then be adopted by name.
    NameReused,
}

impl RetryRefusal {
    // codes: errors
    pub fn code(self) -> &'static str {
        match self {
            RetryRefusal::NoRequest => "repo_request_not_found",
            RetryRefusal::InProgress => "setup_in_progress",
            RetryRefusal::AlreadyReady => "already_ready",
            RetryRefusal::InvalidName => "invalid_argument",
            RetryRefusal::NameReused => "name_reused",
        }
    }
}

/// Decides a retry of a failed or uncertain setup. `holds_repo_id` says whether GitHub's answer to Podster's own creation
/// call gave the request a repository ID. `attempted` is every name an attempt has sent, and `new_name` is one the server
/// just generated: this code has no randomness, so it only checks it.
///
/// An uncertain request never resumes: by definition no ID was recorded for it, so one that claims to hold an ID still
/// gets a new name. A repository is linked only by an ID from a creation answer, never because a name matches.
pub fn decide_retry(
    state: Option<RequestState>,
    holds_repo_id: bool,
    attempted: &[&str],
    new_name: Option<&str>,
) -> Result<RetryPlan, RetryRefusal> {
    match state {
        None => return Err(RetryRefusal::NoRequest),
        Some(RequestState::Pending) => return Err(RetryRefusal::InProgress),
        Some(RequestState::Ready) => return Err(RetryRefusal::AlreadyReady),
        Some(RequestState::Failed) if holds_repo_id => return Ok(RetryPlan::ResumeHeldRepository),
        Some(RequestState::Failed | RequestState::Uncertain) => {}
    }
    let name = new_name
        .filter(|name| valid_repo_name(name))
        .ok_or(RetryRefusal::InvalidName)?;
    if attempted.contains(&name) {
        return Err(RetryRefusal::NameReused);
    }
    Ok(RetryPlan::CreateUnderNewName)
}
