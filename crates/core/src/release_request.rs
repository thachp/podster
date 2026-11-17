//! Asking for a release of a task's merged commit (`requestRelease`; M6 step 6, ADR 0010's "Authority, approval and
//! triggers"): what the room decides once `podster_policy::release` has said who may ask and where. Pure, with no I/O
//! and no clock: `now` is passed in.
//!
//! A request only records a release `awaiting_approval`. Nothing is read from a repository, uploaded or served by it,
//! and nothing starts until a person who may approve approves it (decision 199): ADR 0010's "a `deploy_release`
//! command, then a person's approval. Never a merge, a webhook, or an observation of GitHub."
//!
//! **What is decided here, in this order, the first that fails being the answer:**
//! 1. the environment, of which there is one, and the commit: exactly the one Podster's own merge put on the default
//!    branch of the room's repository and confirmed there, for a completed task ([`crate::release::releasable_commit`]);
//! 2. the room's reviewer rule as it is now: if the room requires a person as reviewer, the task's reviewer was one;
//! 3. the app isn't held because nobody who may release remains (`no_releaser`);
//! 4. no release of the same commit is already waiting or on its way ([`pending_for_commit`]);
//! 5. the room's cap of releases asked for in a rolling day ([`crate::release::release_allowed_today`]), which counts
//!    every request, declined and failed ones included.
//!
//! The job's recheck asks the reviewer rule, the commit and the hold again on every pass, so a request that passes here
//! keeps nothing it isn't asked for again.

use crate::release::{
    releasable_commit, release_allowed_today, CommitRecord, CommitRefusal, ReleaseCapRefusal,
    ReleaseState,
};

/// The state a request leaves a release in: awaiting a person's approval. The one approval policy is `person`.
pub const REQUESTED_STATE: ReleaseState = ReleaseState::AwaitingApproval;

/// Everything a request is decided on, read by the room from its own rows. Nothing here is the caller's but the sha
/// and the environment's name, and both must match the room's records exactly.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReleaseRequest<'a> {
    pub asked_sha: &'a str,
    pub environment: &'a str,
    /// The room's merge record of the task the request names, if it has one.
    pub commit: Option<&'a CommitRecord<'a>>,
    /// The room's own linked repository, by GitHub's ID.
    pub room_repo_id: i64,
    /// The room doesn't require a person as reviewer, or the task's reviewer was one.
    pub reviewer_rule_holds: bool,
    /// The room's app is held because nobody who may release remained (M6 step 6's follow-up to 6d).
    pub app_held: bool,
    /// A release of the same commit is already awaiting approval or on its way ([`pending_for_commit`]).
    pub pending_for_commit: bool,
    /// When each release the room has on record was asked for.
    pub asked_at: &'a [i64],
    pub now: i64,
}

/// Why a request was refused, after policy allowed the caller to ask.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RequestRefusal {
    /// `commit_not_releasable`, or `invalid_argument` for an environment other than the one there is.
    Commit(CommitRefusal),
    /// `reviewer_rule_changed`: the room requires a person as reviewer, and the task's reviewer wasn't one.
    ReviewerRuleChanged,
    /// `no_releaser`: the room's app is held because nobody who may release remained.
    Held,
    /// `release_pending`: a release of this commit is already awaiting approval, queued, uploading or uncertain. Once it
    /// has ended, the commit may be asked for again.
    Pending,
    /// `release_limit`: the room's releases asked for in a rolling day.
    Limit(ReleaseCapRefusal),
}

impl RequestRefusal {
    // codes: reasons
    pub fn code(self) -> &'static str {
        match self {
            RequestRefusal::Commit(refusal) => refusal.code(),
            RequestRefusal::ReviewerRuleChanged => "reviewer_rule_changed",
            RequestRefusal::Held => "no_releaser",
            RequestRefusal::Pending => "release_pending",
            RequestRefusal::Limit(refusal) => refusal.code(),
        }
    }
}

/// Whether a release in `state` holds its commit pending: it is waiting for a person, or its job hasn't finished with
/// it. One that is live or served is the room's and its marker's, and one that ended holds nothing.
pub fn pending_for_commit(state: ReleaseState) -> bool {
    matches!(
        state,
        ReleaseState::AwaitingApproval
            | ReleaseState::Queued
            | ReleaseState::Uploading
            | ReleaseState::Uncertain
    )
}

/// Whether the request may be recorded, as a release [`REQUESTED_STATE`]. The first fact that fails is the answer, in
/// the module's order.
pub fn request_release(r: &ReleaseRequest) -> Result<(), RequestRefusal> {
    releasable_commit(r.asked_sha, r.environment, r.commit, r.room_repo_id)
        .map_err(RequestRefusal::Commit)?;
    if !r.reviewer_rule_holds {
        return Err(RequestRefusal::ReviewerRuleChanged);
    }
    if r.app_held {
        return Err(RequestRefusal::Held);
    }
    if r.pending_for_commit {
        return Err(RequestRefusal::Pending);
    }
    release_allowed_today(r.asked_at, r.now).map_err(RequestRefusal::Limit)
}
