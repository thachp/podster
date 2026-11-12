//! Releasing a room's app: what a release is, its states, which commit may be released, the room's release epoch and
//! what each of its hosts should serve, the unpublish triggers, the job's recheck, script names, and the caps (ADR 0010,
//! M6). Pure, with no I/O and no clock: every time is passed in as `now`, in milliseconds.
//!
//! What a release may contain is [`crate::release_tree`]; a custom hostname's challenge and claim are
//! [`crate::hostnames`]; who may configure, ask for and approve a release is `podster_policy::release`.
//!
//! **Codes.** Every refusal here has a code, from `code()`. They are marked `reasons` while no route answers with them,
//! so the contract's error-code check doesn't require them yet. The step that first answers one in an API error must
//! list it in `Error.code` and change that type's marker to `errors`; the check fails loudly if a `reasons` type's
//! `code()` reaches an `ApiError` before then.

/// How many accepted requests count against a room's cap on releases, over a rolling day (ADR 0010, budgets).
pub const MAX_RELEASES_PER_ROOM_PER_DAY: usize = 20;
/// The rolling window that cap counts over.
pub const RELEASE_WINDOW_MS: i64 = 24 * 60 * 60 * 1000;
/// The release App's reads across the whole deployment, in a rolling hour: nine full-size releases.
pub const MAX_RELEASE_READS_PER_HOUR: u32 = 3_000;
/// The window the read budget counts over.
pub const READ_WINDOW_MS: i64 = 60 * 60 * 1000;
/// How many files are fetched from GitHub at once.
pub const FETCH_CONCURRENCY: usize = 10;
/// How long the job waits for its marker to come back through the host. Provisional until spike G.
pub const MARKER_WAIT_MS: i64 = 30_000;
/// How long a release still uploading keeps its script from the hourly reconcile. Past it the release is failed and its
/// script deleted.
pub const IN_FLIGHT_EXEMPTION_MS: i64 = 60 * 60 * 1000;
/// The one environment a release goes to (decision 214).
pub const ENVIRONMENT: &str = "production";

// ---------------------------------------------------------------------------------------------------------------------
// The approval policy
// ---------------------------------------------------------------------------------------------------------------------

/// How a release is approved. M6 has one value: a person who may approve approves each release. `on_merge` was dropped:
/// with releases only in public rooms it could never publish anything.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApprovalPolicy {
    Person,
}

impl ApprovalPolicy {
    pub fn name(self) -> &'static str {
        match self {
            ApprovalPolicy::Person => "person",
        }
    }

    /// The stored or requested value, exactly. Anything else, `on_merge` included, isn't a policy.
    pub fn parse(value: &str) -> Option<ApprovalPolicy> {
        (value == "person").then_some(ApprovalPolicy::Person)
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Which commit may be released
// ---------------------------------------------------------------------------------------------------------------------

/// What the room's own records say of the commit a release names. Each field is the room's, never a caller's.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CommitRecord<'a> {
    /// The commit's sha, as Podster's merge recorded it.
    pub sha: &'a str,
    /// The repository the merge was made in, by GitHub's ID.
    pub provider_repo_id: i64,
    /// Podster's own merge job put it on the default branch.
    pub merged_by_podster: bool,
    /// And then confirmed it there.
    pub confirmed_on_default_branch: bool,
    /// The task it belongs to was reviewed and is completed.
    pub task_completed: bool,
}

/// Why a commit can't be released.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CommitRefusal {
    /// `commit_not_releasable`: not a commit Podster merged and confirmed on the room's own repository's default branch,
    /// for a completed task. A task branch's head, a commit pushed any other way, and another repository's are never
    /// releasable.
    NotReleasable,
    /// `invalid_argument`: an environment other than the one there is.
    UnknownEnvironment,
}

impl CommitRefusal {
    // codes: reasons
    pub fn code(self) -> &'static str {
        match self {
            CommitRefusal::NotReleasable => "commit_not_releasable",
            CommitRefusal::UnknownEnvironment => "invalid_argument",
        }
    }
}

/// Whether `asked_sha` may be released in `environment`. `record` is the room's merge record for that sha, if it has
/// one, and `room_repo_id` the room's own linked repository. Nothing here is taken from the caller but the sha and the
/// environment's name, and both must match the room's records exactly.
pub fn releasable_commit(
    asked_sha: &str,
    environment: &str,
    record: Option<&CommitRecord>,
    room_repo_id: i64,
) -> Result<(), CommitRefusal> {
    if environment != ENVIRONMENT {
        return Err(CommitRefusal::UnknownEnvironment);
    }
    let ok = record.is_some_and(|r| {
        r.sha == asked_sha
            && !asked_sha.is_empty()
            && r.provider_repo_id == room_repo_id
            && r.merged_by_podster
            && r.confirmed_on_default_branch
            && r.task_completed
    });
    if ok {
        Ok(())
    } else {
        Err(CommitRefusal::NotReleasable)
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// A release's states
// ---------------------------------------------------------------------------------------------------------------------

/// Where one release stands. Each attempt is its own record, and is never rewritten into another.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReleaseState {
    /// Asked for, waiting for a person to approve it.
    AwaitingApproval,
    /// Approved, waiting for its job.
    Queued,
    /// The job is reading the tree, fetching and uploading this release's own script.
    Uploading,
    /// An upload whose answer was lost: settled by Cloudflare's own answer for this release's script.
    Uncertain,
    /// The room committed it live and set its hosts to its script. The job is waiting for its marker.
    Live,
    /// Its marker came back through the host: it is what the room serves.
    Served,
    /// A later release is served in its place. Its script may be kept as the one before, for a rollback.
    Replaced,
    /// The room's app was unpublished while this was live or served.
    Unpublished,
    /// A person who may approve declined it.
    Declined,
    /// It ended without being served, with a reason. An earlier release that was live stays live.
    Failed,
}

impl ReleaseState {
    pub fn name(self) -> &'static str {
        match self {
            ReleaseState::AwaitingApproval => "awaiting_approval",
            ReleaseState::Queued => "queued",
            ReleaseState::Uploading => "uploading",
            ReleaseState::Uncertain => "uncertain",
            ReleaseState::Live => "live",
            ReleaseState::Served => "served",
            ReleaseState::Replaced => "replaced",
            ReleaseState::Unpublished => "unpublished",
            ReleaseState::Declined => "declined",
            ReleaseState::Failed => "failed",
        }
    }

    pub const ALL: [ReleaseState; 10] = [
        ReleaseState::AwaitingApproval,
        ReleaseState::Queued,
        ReleaseState::Uploading,
        ReleaseState::Uncertain,
        ReleaseState::Live,
        ReleaseState::Served,
        ReleaseState::Replaced,
        ReleaseState::Unpublished,
        ReleaseState::Declined,
        ReleaseState::Failed,
    ];

    /// Nothing moves a release out of these: a late or repeated job finds them and changes nothing.
    pub fn is_final(self) -> bool {
        matches!(
            self,
            ReleaseState::Replaced
                | ReleaseState::Unpublished
                | ReleaseState::Declined
                | ReleaseState::Failed
        )
    }

    /// Whether this release's script is, or may be about to be, named by a serve entry.
    pub fn serves(self) -> bool {
        matches!(self, ReleaseState::Live | ReleaseState::Served)
    }
}

/// What happens to a release.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReleaseEvent {
    /// A person who may approve now approves it. Whether they may is decided before this, in `podster_policy`.
    Approve,
    Decline,
    /// The job's pass rechecked everything and starts reading and uploading.
    StartUpload,
    /// The upload's answer was lost.
    UploadUnknown,
    /// Cloudflare's own answer for this release's script says it exists: the upload went through.
    UploadConfirmed,
    /// The room's transaction reran the recheck, epoch included, and committed it live.
    CommitLive,
    /// Its marker came back through the host within the wait.
    MarkerSeen,
    /// A later release was served.
    Replace,
    /// An unpublish trigger, while it was live or served.
    Unpublish,
    /// Any refusal or failure, with its reason recorded beside the state.
    Fail,
}

/// A transition that doesn't exist from the release's state. The room changes nothing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TransitionRefused {
    pub from: ReleaseState,
    pub event: ReleaseEvent,
}

/// The next state of a release, or a refusal that leaves it as it is. A final state takes no event, so a duplicated or
/// late job is a no-op. A release that is live or served can't fail: a failed marker check is a `Fail` from `Live`,
/// and once served only a replacement or an unpublish moves it.
pub fn next_state(
    from: ReleaseState,
    event: ReleaseEvent,
) -> Result<ReleaseState, TransitionRefused> {
    use ReleaseEvent as E;
    use ReleaseState as S;
    let to = match (from, event) {
        (S::AwaitingApproval, E::Approve) => S::Queued,
        (S::AwaitingApproval, E::Decline) => S::Declined,
        (S::AwaitingApproval | S::Queued | S::Uploading | S::Uncertain | S::Live, E::Fail) => {
            S::Failed
        }
        (S::Queued, E::StartUpload) => S::Uploading,
        (S::Uploading, E::UploadUnknown) => S::Uncertain,
        (S::Uncertain, E::UploadConfirmed) => S::Uploading,
        (S::Uploading, E::CommitLive) => S::Live,
        (S::Live, E::MarkerSeen) => S::Served,
        (S::Live | S::Served, E::Replace) => S::Replaced,
        (S::Live | S::Served, E::Unpublish) => S::Unpublished,
        _ => return Err(TransitionRefused { from, event }),
    };
    Ok(to)
}

// ---------------------------------------------------------------------------------------------------------------------
// Script names
// ---------------------------------------------------------------------------------------------------------------------

/// The longest label: lower-case letters and digits only.
pub const MAX_LABEL_LEN: usize = 26;
/// The longest script name: the label, one `.`, and a 36-character ID.
pub const MAX_SCRIPT_NAME_LEN: usize = 63;
/// The length of a release's ID: `rel_` and 32 lower-case hexadecimal characters.
pub const ID_LEN: usize = 36;

/// A host label: 1 to 26 lower-case ASCII letters and digits. Generated by the server, random, and never used again.
pub fn is_label(label: &str) -> bool {
    (1..=MAX_LABEL_LEN).contains(&label.len())
        && label
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

/// The prefix of every release's ID.
pub const RELEASE_ID_PREFIX: &str = "rel_";

/// A release's ID: exactly `rel_` and 32 lower-case hexadecimal characters, 36 in all. Ruled on the review of PR #309:
/// another prefix doesn't make a script name and doesn't parse as one.
pub fn is_release_id(id: &str) -> bool {
    id.len() == ID_LEN
        && id.strip_prefix(RELEASE_ID_PREFIX).is_some_and(|hex| {
            hex.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
}

/// The 26-character label made from 16 random bytes: 128 bits in lower-case base32 (`a`–`z`, `2`–`7`). The caller
/// supplies the randomness, and then [`label_acceptable`] says whether it may be used.
pub fn label_from_random(random: [u8; 16]) -> String {
    const ALPHABET: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";
    let mut out = String::with_capacity(MAX_LABEL_LEN);
    let mut buffer: u32 = 0;
    let mut bits = 0;
    for byte in random {
        buffer = (buffer << 8) | u32::from(byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            let index = ((buffer >> bits) & 31) as usize;
            out.extend(ALPHABET.get(index).map(|b| char::from(*b)));
        }
    }
    if bits > 0 {
        let index = ((buffer << (5 - bits)) & 31) as usize;
        out.extend(ALPHABET.get(index).map(|b| char::from(*b)));
    }
    out
}

/// Whether a generated label may be used: it fits the rule, and holds neither Podster's name nor any word the caller
/// names, such as the room's name, lower-cased. A label that fails is thrown away and another is made. Whether it was
/// used before is the caller's to check, against every label ever issued.
pub fn label_acceptable(label: &str, avoid: &[&str]) -> bool {
    is_label(label)
        && !label.contains("podster")
        && avoid
            .iter()
            .map(|word| word.to_ascii_lowercase())
            .filter(|word| !word.is_empty())
            .all(|word| !label.contains(word.as_str()))
}

/// Why a script name couldn't be made.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScriptNameRefusal {
    BadLabel,
    BadReleaseId,
}

/// A release's script name: the room's label, one `.`, the release's ID. Rust makes the name and nothing else does.
pub fn script_name(label: &str, release_id: &str) -> Result<String, ScriptNameRefusal> {
    if !is_label(label) {
        return Err(ScriptNameRefusal::BadLabel);
    }
    if !is_release_id(release_id) {
        return Err(ScriptNameRefusal::BadReleaseId);
    }
    Ok(format!("{label}.{release_id}"))
}

/// What a script in the namespace is, by its name alone.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ScriptOwner<'a> {
    /// It fits the rule: this label's room made it, for this release.
    Podster { label: &'a str, release_id: &'a str },
    /// It doesn't fit the rule, so Podster didn't make it. Reported to operators and left alone.
    Foreign,
}

/// The inverse of [`script_name`]: which room's label and which release a name belongs to. Exactly one `.`, a label
/// before it and a release's ID after it, and nothing else, or it isn't Podster's. The length cap is implied by the two
/// parts' own rules (26 + 1 + 36) and kept as a guard of its own, so a later loosening of either part can't pass it.
pub fn script_owner(name: &str) -> ScriptOwner<'_> {
    if name.len() > MAX_SCRIPT_NAME_LEN {
        return ScriptOwner::Foreign;
    }
    match name.split_once('.') {
        Some((label, release_id)) if is_label(label) && is_release_id(release_id) => {
            ScriptOwner::Podster { label, release_id }
        }
        _ => ScriptOwner::Foreign,
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// The release epoch and the desired serve state
// ---------------------------------------------------------------------------------------------------------------------

/// What one of the room's hosts should serve: one script or nothing, with a version that goes up on every change.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DesiredServe {
    pub script: Option<String>,
    pub version: u64,
    /// Closed to releases: a custom hostname whose claim is ending or whose name is suspended. A commit, a rollback and
    /// a set-back never write to a closed host; only [`open_host`] reopens one, for a new claim.
    pub closed: bool,
}

/// The room's release state that decides serving: its epoch, which only goes up, and each host's desired serve state,
/// the default host first and a custom hostname after it. Only room transactions change it, through the functions here.
#[derive(Clone, Debug, PartialEq, Eq)]
///
/// **One release in flight at a time, enforced here.** A commit or a rollback sets `awaiting_marker`; its marker's
/// confirmation ([`confirm_served`]), its set-back ([`set_back`]) or an unpublish clears it; and while it is set
/// [`commit_live`] and [`rollback`] refuse `release_in_flight`. So a commit's `before` can never hold an unconfirmed
/// script. The room also runs its release jobs one at a time, in order, but core doesn't rely on that.
pub struct ServeState {
    pub epoch: u64,
    pub hosts: Vec<DesiredServe>,
    /// The script of the release before the live one, kept for a rollback. Forgotten by an unpublish.
    pub kept_previous: Option<String>,
    /// A commit or rollback is waiting for its marker. Added after the second review of PR #311.
    pub awaiting_marker: bool,
}

/// What a live commit wrote, which a later set-back compares host by host, and an unpublish reads for the script that
/// was live before.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommitMark {
    pub epoch: u64,
    /// For each host, the version the commit wrote, or `None` where it didn't write because the host was closed.
    pub versions: Vec<Option<u64>>,
    /// What each host served before the commit, to put back.
    pub before: Vec<Option<String>>,
}

/// Why the room refused to commit a release live, or a rollback.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CommitLiveRefusal {
    /// `release_epoch_moved`: something unpublished the room after this release started. It can never go live.
    EpochMoved,
    /// `release_already_live`: an open host already serves this script. A repeated commit changes nothing.
    AlreadyLive,
    /// `release_epoch_exhausted`: the epoch or a version can't go up again. Fails closed: nothing goes live.
    Exhausted,
    /// `release_in_flight`: another commit or rollback is still waiting for its marker. Added after the second review of
    /// PR #311.
    InFlight,
}

impl CommitLiveRefusal {
    // codes: reasons
    pub fn code(self) -> &'static str {
        match self {
            CommitLiveRefusal::EpochMoved => "release_epoch_moved",
            CommitLiveRefusal::AlreadyLive => "release_already_live",
            CommitLiveRefusal::Exhausted => "release_epoch_exhausted",
            CommitLiveRefusal::InFlight => "release_in_flight",
        }
    }
}

/// A version one higher, if it stays below `u64::MAX`, which is kept for the saturated "can't move" state.
fn bump(version: u64) -> Option<u64> {
    version.checked_add(1).filter(|v| *v < u64::MAX)
}

/// The room's commit of a release as live: only under the epoch the release started under, never twice, and only on
/// open hosts. Each open host goes to the release's script; a closed host is left exactly as it is. It returns the mark a
/// set-back and an unpublish read. The previous live script becomes the kept one only once this release is served
/// ([`after_served`]).
pub fn commit_live(
    state: &ServeState,
    release_epoch: u64,
    script: &str,
) -> Result<(ServeState, CommitMark), CommitLiveRefusal> {
    if state.epoch == u64::MAX {
        return Err(CommitLiveRefusal::Exhausted);
    }
    if state.epoch != release_epoch {
        return Err(CommitLiveRefusal::EpochMoved);
    }
    if state.awaiting_marker {
        return Err(CommitLiveRefusal::InFlight);
    }
    if state
        .hosts
        .iter()
        .any(|h| !h.closed && h.script.as_deref() == Some(script))
    {
        return Err(CommitLiveRefusal::AlreadyLive);
    }
    let mut hosts = Vec::with_capacity(state.hosts.len());
    let mut versions = Vec::with_capacity(state.hosts.len());
    for host in &state.hosts {
        if host.closed {
            hosts.push(host.clone());
            versions.push(None);
            continue;
        }
        let version = bump(host.version).ok_or(CommitLiveRefusal::Exhausted)?;
        hosts.push(DesiredServe {
            script: Some(script.to_owned()),
            version,
            closed: false,
        });
        versions.push(Some(version));
    }
    let mark = CommitMark {
        epoch: state.epoch,
        versions,
        before: state.hosts.iter().map(|h| h.script.clone()).collect(),
    };
    Ok((
        ServeState {
            epoch: state.epoch,
            hosts,
            kept_previous: state.kept_previous.clone(),
            awaiting_marker: true,
        },
        mark,
    ))
}

/// What a confirmed release does to the scripts the room keeps: the release's script is live, the one live before it
/// is kept for a rollback, and the one kept before that is returned, to be deleted.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AfterServed {
    pub kept_previous: Option<String>,
    pub delete: Option<String>,
}

/// After a release's marker came back: `previous_live` is the script the default host served before its commit.
pub fn after_served(state: &ServeState, previous_live: Option<&str>, script: &str) -> AfterServed {
    let previous = previous_live.filter(|p| *p != script).map(str::to_owned);
    let delete = state
        .kept_previous
        .clone()
        .filter(|kept| Some(kept) != previous.as_ref() && kept != script);
    AfterServed {
        kept_previous: previous,
        delete,
    }
}

/// The set-back after a release's marker never came back.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SetBack {
    pub state: ServeState,
    /// The hosts put back to what they served before.
    pub reverted: Vec<usize>,
    /// Whether the failed release's script may be deleted now: no host of the new state names it. When false, a host
    /// that changed since still serves it, and the caller must not delete it; the script-delete job runs when the last
    /// host stops naming it.
    pub delete_script: bool,
}

/// The set-back after a release's marker never came back, **host by host**: a host goes back to what it served before
/// only if the epoch is still the commit's and that host's own version is still exactly what the commit wrote. A host
/// that changed since, or was closed, stays as it is. An unpublish since moved the epoch, so nothing is set back.
pub fn set_back(state: &ServeState, mark: &CommitMark, script: &str) -> SetBack {
    let epoch_holds = state.epoch == mark.epoch && state.epoch != u64::MAX;
    let mut reverted = Vec::new();
    let hosts: Vec<DesiredServe> = state
        .hosts
        .iter()
        .enumerate()
        .map(|(i, host)| {
            let wrote = mark.versions.get(i).copied().flatten();
            let before = mark.before.get(i);
            match (
                epoch_holds && !host.closed,
                wrote,
                before,
                bump(host.version),
            ) {
                (true, Some(v), Some(before), Some(next)) if host.version == v => {
                    reverted.push(i);
                    DesiredServe {
                        script: before.clone(),
                        version: next,
                        closed: false,
                    }
                }
                _ => host.clone(),
            }
        })
        .collect();
    // Never while a host names it, nor while it is the kept script, which a failed rollback's script is.
    let delete_script = !hosts.iter().any(|h| h.script.as_deref() == Some(script))
        && state.kept_previous.as_deref() != Some(script);
    SetBack {
        state: ServeState {
            epoch: state.epoch,
            hosts,
            kept_previous: state.kept_previous.clone(),
            awaiting_marker: if epoch_holds {
                false
            } else {
                state.awaiting_marker
            },
        },
        reverted,
        delete_script,
    }
}

/// Why a rollback can't switch.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RollbackRefusal {
    /// `release_epoch_moved`, `release_already_live` or `release_epoch_exhausted`, as for a commit.
    Commit(CommitLiveRefusal),
    /// `rollback_not_kept`: nothing is kept, or Cloudflare says the kept script is gone. A rollback is then a new release
    /// of that commit, uploaded again.
    NotKept,
}

impl RollbackRefusal {
    // codes: reasons
    pub fn code(self) -> &'static str {
        match self {
            RollbackRefusal::Commit(refusal) => refusal.code(),
            RollbackRefusal::NotKept => "rollback_not_kept",
        }
    }
}

/// A rollback to the release before: a switch of every open host to the kept script, under the epoch the rollback
/// started under, and only once Cloudflare's own answer says that script still exists (`kept_exists`). Closed hosts are
/// left as they are, as for a commit. It returns the new state and the mark: the rollback is its own release, and waits
/// for its marker like any other.
pub fn rollback(
    state: &ServeState,
    release_epoch: u64,
    kept_exists: bool,
) -> Result<(ServeState, CommitMark), RollbackRefusal> {
    let kept = state
        .kept_previous
        .clone()
        .filter(|_| kept_exists)
        .ok_or(RollbackRefusal::NotKept)?;
    commit_live(state, release_epoch, &kept).map_err(RollbackRefusal::Commit)
}

// ---------------------------------------------------------------------------------------------------------------------
// Unpublishing
// ---------------------------------------------------------------------------------------------------------------------

/// Everything that unpublishes a room's app (ADR 0010, unpublishing). Each, in the trigger's own room transaction,
/// records it, raises the release epoch, sets every host to nothing, and forgets the kept scripts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UnpublishTrigger {
    ReleaseOffInRoom,
    ReleaseOffForDeployment,
    RoomArchived,
    RoomDeleted,
    RoomMadePrivate,
    OrganizationDeleted,
    PublicSurfaceSuspended,
    AppSuspended,
    ReleaseTakenFromOrganization,
    /// The repository stopped or lost: suspended by an operator, found gone, or its link no longer ready.
    RepositoryNotReady,
    /// Assumed, for the owner: nobody who may release now remains in the room.
    NoReleaserLeft,
}

impl UnpublishTrigger {
    pub const ALL: [UnpublishTrigger; 11] = [
        UnpublishTrigger::ReleaseOffInRoom,
        UnpublishTrigger::ReleaseOffForDeployment,
        UnpublishTrigger::RoomArchived,
        UnpublishTrigger::RoomDeleted,
        UnpublishTrigger::RoomMadePrivate,
        UnpublishTrigger::OrganizationDeleted,
        UnpublishTrigger::PublicSurfaceSuspended,
        UnpublishTrigger::AppSuspended,
        UnpublishTrigger::ReleaseTakenFromOrganization,
        UnpublishTrigger::RepositoryNotReady,
        UnpublishTrigger::NoReleaserLeft,
    ];

    // codes: reasons
    pub fn code(self) -> &'static str {
        match self {
            UnpublishTrigger::ReleaseOffInRoom => "release_off",
            UnpublishTrigger::ReleaseOffForDeployment => "release_off_for_deployment",
            UnpublishTrigger::RoomArchived => "workspace_archived",
            UnpublishTrigger::RoomDeleted => "workspace_deleted",
            UnpublishTrigger::RoomMadePrivate => "release_needs_public_room",
            UnpublishTrigger::OrganizationDeleted => "organization_deleted",
            UnpublishTrigger::PublicSurfaceSuspended => "public_surface_suspended",
            UnpublishTrigger::AppSuspended => "app_suspended",
            UnpublishTrigger::ReleaseTakenFromOrganization => "release_not_delegated",
            UnpublishTrigger::RepositoryNotReady => "repo_not_ready",
            UnpublishTrigger::NoReleaserLeft => "no_releaser",
        }
    }
}

/// The trigger's own change to the room's serve state: the epoch up by one, every host to nothing with its version up,
/// and the kept script forgotten, so nothing can be rolled back to afterwards. The scripts to delete are what the hosts
/// served, what was kept, and, when an unpublish lands between a commit and its marker, what was live before that
/// commit (`in_flight`, the commit's mark). An unpublish of a room serving nothing still raises the epoch, so a release in
/// flight can't go live after it.
///
/// **It never fails.** If the epoch can't go up it is set to `u64::MAX`, which [`commit_live`] and [`rollback`] refuse
/// for ever, so the room fails closed; a version that can't go up stays at `u64::MAX`, which no commit writes.
pub fn unpublish(state: &ServeState, in_flight: Option<&CommitMark>) -> (ServeState, Vec<String>) {
    let mut delete: Vec<String> = state
        .hosts
        .iter()
        .filter_map(|h| h.script.clone())
        .collect();
    delete.extend(state.kept_previous.clone());
    if let Some(mark) = in_flight {
        delete.extend(mark.before.iter().flatten().cloned());
    }
    delete.sort();
    delete.dedup();
    (
        ServeState {
            epoch: state.epoch.saturating_add(1),
            hosts: state
                .hosts
                .iter()
                .map(|h| DesiredServe {
                    script: None,
                    version: h.version.saturating_add(1),
                    closed: h.closed,
                })
                .collect(),
            kept_previous: None,
            awaiting_marker: false,
        },
        delete,
    )
}

/// One custom hostname's claim ending, or its name suspended, which isn't an unpublish: that host alone goes to nothing
/// and is closed, first, so its applier removes the entry before the hostname is deleted at Cloudflare, and no commit,
/// rollback or set-back writes to it again. The epoch doesn't move. `None` if there's no such host.
pub fn clear_host(state: &ServeState, host: usize) -> Option<ServeState> {
    state.hosts.get(host)?;
    Some(ServeState {
        epoch: state.epoch,
        hosts: state
            .hosts
            .iter()
            .enumerate()
            .map(|(i, h)| {
                if i == host {
                    DesiredServe {
                        script: None,
                        version: h.version.saturating_add(1),
                        closed: true,
                    }
                } else {
                    h.clone()
                }
            })
            .collect(),
        kept_previous: state.kept_previous.clone(),
        awaiting_marker: state.awaiting_marker,
    })
}

/// The script the room last confirmed served, from its own state: the default host's script as the release before an
/// in-flight commit left it (`in_flight`, that commit's mark, while its marker hasn't come back), or the default host's
/// script now when nothing is in flight. Nothing when the room is unpublished, or no release was ever confirmed. A mark
/// from before an unpublish (its epoch no longer the room's) counts as nothing in flight.
pub fn confirmed_script(state: &ServeState, in_flight: Option<&CommitMark>) -> Option<String> {
    match in_flight.filter(|mark| mark.epoch == state.epoch) {
        Some(mark) => mark.before.first().cloned().flatten(),
        None => state
            .hosts
            .first()
            .filter(|h| !h.closed)
            .and_then(|h| h.script.clone()),
    }
}

/// A custom hostname newly claimed and reported `active` (`hostnames::routing_may_start`): that host opens on the
/// release the room last confirmed served ([`confirmed_script`]), or nothing. It takes no script from its caller: what it
/// serves comes from the room's state and the in-flight commit's mark, so an unpublished room opens it on nothing, and
/// between a commit and its marker it never takes the unconfirmed script. When that marker comes back,
/// [`confirm_served`] moves it to the confirmed release with every other open host; if it doesn't, the set-back leaves
/// it where it is. `None` if there's no such host, or its version can't go up.
pub fn open_host(
    state: &ServeState,
    host: usize,
    in_flight: Option<&CommitMark>,
) -> Option<ServeState> {
    let target = state.hosts.get(host)?;
    let version = bump(target.version)?;
    let live = confirmed_script(state, in_flight);
    Some(ServeState {
        epoch: state.epoch,
        hosts: state
            .hosts
            .iter()
            .enumerate()
            .map(|(i, h)| {
                if i == host {
                    DesiredServe {
                        script: live.clone(),
                        version,
                        closed: false,
                    }
                } else {
                    h.clone()
                }
            })
            .collect(),
        kept_previous: state.kept_previous.clone(),
        awaiting_marker: state.awaiting_marker,
    })
}

/// What a release's marker coming back does, in one room decision.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Confirmed {
    pub state: ServeState,
    /// The open hosts moved to the release here, the ones opened while it was in flight.
    pub caught_up: Vec<usize>,
    /// The kept script and the one to delete, as [`after_served`] decides them.
    pub after: AfterServed,
}

/// A release's marker came back: it is confirmed served. Under the commit's own epoch, every open host that doesn't
/// name the release yet, which is one opened while it was in flight, moves to it (the catch-up); the release before it
/// becomes the kept one, and the one kept before that is to be deleted ([`after_served`]). `None` if the epoch moved
/// since the commit, when nothing is confirmed: an unpublish spoke, and the room serves nothing. A closed host is never
/// written. Only while the default host still holds the version and the script the commit wrote; otherwise `None`.
pub fn confirm_served(state: &ServeState, mark: &CommitMark, script: &str) -> Option<Confirmed> {
    if state.epoch != mark.epoch || state.epoch == u64::MAX {
        return None;
    }
    // Only while the default host is still exactly what this commit wrote: a late success after a set-back, or a stale
    // one after a later release, confirms nothing. A repeated confirm finds it unchanged, and changes nothing more.
    let default_holds = matches!(
        (state.hosts.first(), mark.versions.first()),
        (Some(host), Some(Some(version)))
            if host.version == *version && !host.closed && host.script.as_deref() == Some(script)
    );
    if !default_holds {
        return None;
    }
    let mut caught_up = Vec::new();
    let mut hosts = Vec::with_capacity(state.hosts.len());
    for (i, host) in state.hosts.iter().enumerate() {
        if host.closed || host.script.as_deref() == Some(script) {
            hosts.push(host.clone());
            continue;
        }
        let version = bump(host.version)?;
        caught_up.push(i);
        hosts.push(DesiredServe {
            script: Some(script.to_owned()),
            version,
            closed: false,
        });
    }
    let previous = mark.before.first().cloned().flatten();
    let after = after_served(state, previous.as_deref(), script);
    Some(Confirmed {
        state: ServeState {
            epoch: state.epoch,
            hosts,
            kept_previous: after.kept_previous.clone(),
            awaiting_marker: false,
        },
        caught_up,
        after,
    })
}

/// The room's facts that decide whether its app may be up, read from its current state and its organization's.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RoomReleaseFacts {
    pub release_on_in_room: bool,
    pub deployment_allows_release: bool,
    pub archived: bool,
    pub deleted: bool,
    pub public: bool,
    pub organization_exists: bool,
    pub public_surface_suspended: bool,
    pub app_suspended: bool,
    pub organization_may_release: bool,
    pub repository_ready: bool,
    /// Someone who may release now remains in the room: see `podster_policy::release::may_release_now`.
    pub someone_may_release: bool,
}

impl RoomReleaseFacts {
    /// A room where nothing stands in the way, for tests and as a starting point.
    pub const OPEN: RoomReleaseFacts = RoomReleaseFacts {
        release_on_in_room: true,
        deployment_allows_release: true,
        archived: false,
        deleted: false,
        public: true,
        organization_exists: true,
        public_surface_suspended: false,
        app_suspended: false,
        organization_may_release: true,
        repository_ready: true,
        someone_may_release: true,
    };
}

/// Every trigger the facts show, in [`UnpublishTrigger::ALL`]'s order. Empty means the app may stay up.
pub fn unpublish_triggers(facts: &RoomReleaseFacts) -> Vec<UnpublishTrigger> {
    use UnpublishTrigger as T;
    let checks = [
        (!facts.release_on_in_room, T::ReleaseOffInRoom),
        (!facts.deployment_allows_release, T::ReleaseOffForDeployment),
        (facts.archived, T::RoomArchived),
        (facts.deleted, T::RoomDeleted),
        (!facts.public, T::RoomMadePrivate),
        (!facts.organization_exists, T::OrganizationDeleted),
        (facts.public_surface_suspended, T::PublicSurfaceSuspended),
        (facts.app_suspended, T::AppSuspended),
        (
            !facts.organization_may_release,
            T::ReleaseTakenFromOrganization,
        ),
        (!facts.repository_ready, T::RepositoryNotReady),
        (!facts.someone_may_release, T::NoReleaserLeft),
    ];
    checks
        .into_iter()
        .filter_map(|(fires, trigger)| fires.then_some(trigger))
        .collect()
}

// ---------------------------------------------------------------------------------------------------------------------
// The job's recheck, on every pass
// ---------------------------------------------------------------------------------------------------------------------

/// What the job rechecks on every pass, and the room again inside the transaction that commits a release live. Each
/// field is read from current state; the policy answers come from `podster_policy::release`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Recheck<'a> {
    pub room: RoomReleaseFacts,
    /// The stop for the whole content domain is set.
    pub domain_stopped: bool,
    pub config_version_now: u64,
    pub config_version_asked: u64,
    pub requester_may_release_now: bool,
    pub approver_may_approve_now: bool,
    /// The room still requires a person as reviewer, or the release's task wasn't reviewed under that rule.
    pub reviewer_rule_holds: bool,
    pub commit: Option<&'a CommitRecord<'a>>,
    pub asked_sha: &'a str,
    pub room_repo_id: i64,
    pub epoch_now: u64,
    pub epoch_at_start: u64,
}

/// Why a pass ends the release as failed, before any call to GitHub or Cloudflare.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RecheckFailure {
    /// `release_stopped`: the stop for the whole content domain is set.
    DomainStopped,
    Trigger(UnpublishTrigger),
    /// `release_config_changed`
    ConfigChanged,
    /// `requester_lost_authority`
    RequesterLostAuthority,
    /// `approver_lost_authority`
    ApproverLostAuthority,
    /// `reviewer_rule_changed`
    ReviewerRuleChanged,
    Commit(CommitRefusal),
    EpochMoved,
}

impl RecheckFailure {
    // codes: reasons
    pub fn code(self) -> &'static str {
        match self {
            RecheckFailure::DomainStopped => "release_stopped",
            RecheckFailure::Trigger(trigger) => trigger.code(),
            RecheckFailure::ConfigChanged => "release_config_changed",
            RecheckFailure::RequesterLostAuthority => "requester_lost_authority",
            RecheckFailure::ApproverLostAuthority => "approver_lost_authority",
            RecheckFailure::ReviewerRuleChanged => "reviewer_rule_changed",
            RecheckFailure::Commit(refusal) => refusal.code(),
            RecheckFailure::EpochMoved => CommitLiveRefusal::EpochMoved.code(),
        }
    }
}

/// The whole recheck, in the ADR's order: deployment and stop, the organization, the room, the repository, the room's
/// switch and configuration version, the requester, the approver, the reviewer rule, the commit, and the epoch. The
/// first that fails is the reason. A room where no one may release is a trigger, so it fails here too.
pub fn recheck(r: &Recheck) -> Result<(), RecheckFailure> {
    if !r.room.deployment_allows_release {
        return Err(RecheckFailure::Trigger(
            UnpublishTrigger::ReleaseOffForDeployment,
        ));
    }
    if r.domain_stopped {
        return Err(RecheckFailure::DomainStopped);
    }
    let order = [
        UnpublishTrigger::OrganizationDeleted,
        UnpublishTrigger::ReleaseTakenFromOrganization,
        UnpublishTrigger::RoomDeleted,
        UnpublishTrigger::RoomMadePrivate,
        UnpublishTrigger::RoomArchived,
        UnpublishTrigger::PublicSurfaceSuspended,
        UnpublishTrigger::AppSuspended,
        UnpublishTrigger::RepositoryNotReady,
        UnpublishTrigger::ReleaseOffInRoom,
    ];
    let fired = unpublish_triggers(&r.room);
    if let Some(trigger) = order.iter().find(|t| fired.contains(t)) {
        return Err(RecheckFailure::Trigger(*trigger));
    }
    if r.config_version_now != r.config_version_asked {
        return Err(RecheckFailure::ConfigChanged);
    }
    if !r.requester_may_release_now {
        return Err(RecheckFailure::RequesterLostAuthority);
    }
    if !r.approver_may_approve_now {
        return Err(RecheckFailure::ApproverLostAuthority);
    }
    if fired.contains(&UnpublishTrigger::NoReleaserLeft) {
        return Err(RecheckFailure::Trigger(UnpublishTrigger::NoReleaserLeft));
    }
    if !r.reviewer_rule_holds {
        return Err(RecheckFailure::ReviewerRuleChanged);
    }
    releasable_commit(r.asked_sha, ENVIRONMENT, r.commit, r.room_repo_id)
        .map_err(RecheckFailure::Commit)?;
    if r.epoch_now != r.epoch_at_start {
        return Err(RecheckFailure::EpochMoved);
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------------------------------
// Caps and budgets
// ---------------------------------------------------------------------------------------------------------------------

/// The oldest time still inside a rolling window of `window_ms` at `now`: a stamp at it or later counts.
pub fn window_start(now: i64, window_ms: i64) -> i64 {
    now.saturating_sub(window_ms).saturating_add(1)
}

/// Why a release can't start now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReleaseCapRefusal {
    /// `release_limit`: 20 releases asked for in this room in the last 24 hours.
    DailyLimit,
    /// `release_reads_budget`: the deployment's release reads for the hour would pass 3,000. The release waits.
    ReadBudget,
}

impl ReleaseCapRefusal {
    // codes: reasons
    pub fn code(self) -> &'static str {
        match self {
            ReleaseCapRefusal::DailyLimit => "release_limit",
            ReleaseCapRefusal::ReadBudget => "release_reads_budget",
        }
    }
}

/// Whether one more release may be asked for in a room, given when its earlier ones were asked for: fewer than 20 in
/// the rolling day. Every request counts, failed and declined ones included.
pub fn release_allowed_today(asked_at: &[i64], now: i64) -> Result<(), ReleaseCapRefusal> {
    let start = window_start(now, RELEASE_WINDOW_MS);
    if asked_at.iter().filter(|at| **at >= start).count() >= MAX_RELEASES_PER_ROOM_PER_DAY {
        Err(ReleaseCapRefusal::DailyLimit)
    } else {
        Ok(())
    }
}

/// The reads a release of `files` files costs: the commit's top tree, the directory's tree, and one per file.
pub fn reads_for_release(files: u32) -> u32 {
    files.saturating_add(2)
}

/// Whether a release's reads fit the deployment's hour, counted by Podster itself: `used` reads already made in the
/// rolling hour, and `needed` for this release. Past it the release waits; it isn't failed.
pub fn reads_fit(used: u32, needed: u32) -> Result<(), ReleaseCapRefusal> {
    if used.saturating_add(needed) <= MAX_RELEASE_READS_PER_HOUR {
        Ok(())
    } else {
        Err(ReleaseCapRefusal::ReadBudget)
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Confirming what Cloudflare and the host say
// ---------------------------------------------------------------------------------------------------------------------

/// One answer from Cloudflare about one script.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScriptAnswer {
    /// A read of the script: its status, and whether its body's `script` was `null`.
    Read { status: u16, script_null: bool },
    /// A delete of the script: its status, and the error code in its body, if any.
    Delete { status: u16, code: Option<i64> },
}

/// Whether an answer says the script is gone: a read answering `200` with `"script": null`, or a delete answering
/// `404` with code `10007`. Nothing else, a read's `404` included, and the delete is retried.
pub fn script_gone(answer: ScriptAnswer) -> bool {
    matches!(
        answer,
        ScriptAnswer::Read {
            status: 200,
            script_null: true
        } | ScriptAnswer::Delete {
            status: 404,
            code: Some(10007)
        }
    )
}

/// Whether an answer says the script exists, which a rollback needs before it switches: a read answering `200` with a
/// script object.
pub fn script_exists(answer: ScriptAnswer) -> bool {
    matches!(
        answer,
        ScriptAnswer::Read {
            status: 200,
            script_null: false
        }
    )
}

/// What the job concludes from its marker.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MarkerOutcome {
    /// It came back as this release's: record it served.
    Served,
    /// Not yet, and the wait isn't over: fetch again.
    Wait,
    /// The wait is over and it never came back: fail the release, and set back under its condition.
    Failed,
}

/// `seen` is the release ID the host's marker named, if it answered with one; `waited_ms` how long since the room's
/// commit. Another release's marker, or none, is not this release's.
pub fn marker_outcome(seen: Option<&str>, release_id: &str, waited_ms: i64) -> MarkerOutcome {
    if seen == Some(release_id) {
        MarkerOutcome::Served
    } else if waited_ms < MARKER_WAIT_MS {
        MarkerOutcome::Wait
    } else {
        MarkerOutcome::Failed
    }
}

/// What the hourly reconcile does with one script in the namespace.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScriptReconcile {
    /// A room claims it: live, kept, or uploading within its hour.
    Keep,
    /// Its name fits the rule and no room claims it, or its upload outlived the hour: delete it.
    Delete,
    /// Its name doesn't fit the rule: Podster didn't make it. Report it to operators and leave it alone.
    ReportForeign,
    /// The lookup found no room for its label: report it, and never delete on a projection's word alone.
    ReportUnowned,
}

/// The room's answer for a script, asked by its label.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RoomClaim {
    /// No room could be found for the label.
    NoRoom,
    /// The room serves it or keeps it.
    Claims,
    /// The room's record says a release with this script began uploading at this time.
    Uploading { since: i64 },
    /// The room was found and claims nothing of this name. **Only the label's own room may give this answer**, read from
    /// its own current state: the label is the part of the name before its `.`, and a label belongs to one room for ever.
    /// A lookup table only routes the question to that room; its word alone never makes a script `Disowns`.
    Disowns,
}

/// The hourly reconcile's decision for one script, given its name and what its room says.
pub fn reconcile_script(name: &str, room: RoomClaim, now: i64) -> ScriptReconcile {
    if script_owner(name) == ScriptOwner::Foreign {
        return ScriptReconcile::ReportForeign;
    }
    match room {
        RoomClaim::NoRoom => ScriptReconcile::ReportUnowned,
        RoomClaim::Claims => ScriptReconcile::Keep,
        RoomClaim::Uploading { since } if now.saturating_sub(since) < IN_FLIGHT_EXEMPTION_MS => {
            ScriptReconcile::Keep
        }
        RoomClaim::Uploading { .. } | RoomClaim::Disowns => ScriptReconcile::Delete,
    }
}
