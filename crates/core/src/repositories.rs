//! Managed repositories: the states a room keeps for M5 (ADR 0009, which is proposed). No I/O.
//!
//! M5 step 2 adds only the names of those states and the one rule every later step leans on: a repository lets a token be
//! issued or a merge run only while its link is `ready`. Nothing calls that rule yet, since no route issues or merges. Grant checks, commit pinning and merge decisions are step 3's.
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
}

impl MergeState {
    pub fn name(self) -> &'static str {
        match self {
            MergeState::NotRequested => "not_requested",
            MergeState::Requested => "requested",
            MergeState::Succeeded => "succeeded",
            MergeState::Failed => "failed",
        }
    }

    pub fn from_name(name: &str) -> Option<MergeState> {
        [
            MergeState::NotRequested,
            MergeState::Requested,
            MergeState::Succeeded,
            MergeState::Failed,
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
