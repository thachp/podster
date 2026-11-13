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
    /// Podster's own merge job called the merge of it. The room's record doesn't say whose call merged it: a person
    /// who merges the same pull request by hand, after Podster's call was made and before its outcome was known,
    /// leaves the same record. What is released is the reviewed commit either way.
    pub merged_by_podster: bool,
    /// And then confirmed it there.
    pub confirmed_on_default_branch: bool,
    /// The task it belongs to was reviewed and is completed.
    pub task_completed: bool,
}

/// Why a commit can't be released.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CommitRefusal {
    /// `commit_not_releasable`: not a commit whose merge Podster called and then confirmed on the room's own
    /// repository's default branch, for a completed task. A task branch's head, a commit pushed any other way, and another repository's are never
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
/// **One release in flight at a time, enforced here, by identity.** `in_flight` names the one commit or rollback
/// waiting for its marker: its script and its mark. [`commit_live`] replays that same commit's answer, and refuses any
/// other with `release_in_flight`; [`rollback`] is refused while anything is in flight. Only the completion of that
/// exact commit, [`confirm_served`] or [`set_back`], clears it, and so does [`unpublish`]; a completion for any other
/// mark is stale, and changes nothing. Nothing else touches it. The room also runs its release jobs one at a time, in
/// order, but core doesn't rely on that.
///
/// **Core has no timeout.** The caller must end every flight with a confirm, a set-back or an unpublish; an unpublish
/// always can.
pub struct ServeState {
    pub epoch: u64,
    pub hosts: Vec<DesiredServe>,
    /// The script of the release before the live one, kept for a rollback. Forgotten by an unpublish.
    pub kept_previous: Option<String>,
    /// The commit or rollback waiting for its marker, if one is. Added in the reviews of PR #311.
    pub in_flight: Option<InFlight>,
}

/// The one commit waiting for its marker: its script, which names its release, and the mark it wrote. A completion acts
/// only for exactly this.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InFlight {
    /// The release record the flight is for: a commit's own release, or the rollback's own record, never the release
    /// the rolled-back script came from. Added after the review of PR #312.
    pub release_id: String,
    pub script: String,
    pub mark: CommitMark,
}

impl InFlight {
    /// Whether a completion for `mark` and `script` is for this flight.
    pub fn is(&self, mark: &CommitMark, script: &str) -> bool {
        self.script == script && &self.mark == mark
    }
}

/// A completion that isn't for the commit in flight: a late, repeated or stale answer. It changes nothing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StaleCompletion;

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
    /// `release_ended`: the release already ended (failed, declined, replaced or unpublished). It can never go live, even
    /// if the same script is asked for again after its set-back. Added after the review of PR #311.
    ReleaseEnded,
    /// `release_not_uploading`: the release isn't at the step that commits it live: still awaiting approval or queued,
    /// its upload uncertain, or already served. Added after the review of PR #311.
    ReleaseNotUploading,
}

impl CommitLiveRefusal {
    // codes: reasons
    pub fn code(self) -> &'static str {
        match self {
            CommitLiveRefusal::EpochMoved => "release_epoch_moved",
            CommitLiveRefusal::AlreadyLive => "release_already_live",
            CommitLiveRefusal::Exhausted => "release_epoch_exhausted",
            CommitLiveRefusal::InFlight => "release_in_flight",
            CommitLiveRefusal::ReleaseEnded => "release_ended",
            CommitLiveRefusal::ReleaseNotUploading => "release_not_uploading",
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
///
/// `release` is the release's own state, from its record: core refuses to commit one that isn't uploading, so a release
/// that ended (failed after its set-back among them) never goes live again, whatever the serve state says.
///
/// `release_id` is the release record asking: the release's own, or a rollback's own. A retry of the commit in flight is
/// recognised only when the record, the script and the epoch are all the flight's, and its record says live or still
/// uploading; then it replays the first answer, so a retried job is never told to fail and delete its own script. An
/// ended record asking for the flight's script is refused `release_ended`, a record at any other step
/// `release_not_uploading`, and anything else while a flight is open `release_in_flight`.
pub fn commit_live(
    state: &ServeState,
    release_epoch: u64,
    script: &str,
    release_id: &str,
    release: ReleaseState,
) -> Result<(ServeState, CommitMark), CommitLiveRefusal> {
    if let Some(flight) = &state.in_flight {
        if flight.script == script && release.is_final() {
            return Err(CommitLiveRefusal::ReleaseEnded);
        }
        if flight.release_id != release_id || flight.script != script {
            return Err(CommitLiveRefusal::InFlight);
        }
        if flight.mark.epoch != release_epoch {
            return Err(CommitLiveRefusal::EpochMoved);
        }
        if !matches!(release, ReleaseState::Live | ReleaseState::Uploading) {
            return Err(CommitLiveRefusal::ReleaseNotUploading);
        }
        return Ok((state.clone(), flight.mark.clone()));
    }
    if release.is_final() {
        return Err(CommitLiveRefusal::ReleaseEnded);
    }
    if release != ReleaseState::Uploading {
        return Err(CommitLiveRefusal::ReleaseNotUploading);
    }
    if state.epoch == u64::MAX {
        return Err(CommitLiveRefusal::Exhausted);
    }
    if state.epoch != release_epoch {
        return Err(CommitLiveRefusal::EpochMoved);
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
            in_flight: Some(InFlight {
                release_id: release_id.to_owned(),
                script: script.to_owned(),
                mark: mark.clone(),
            }),
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
/// Only the failure of the commit in flight does anything; for any other mark the answer is [`StaleCompletion`], which
/// changes nothing and orders nothing deleted, and can't be mistaken for a set-back that happened.
pub fn set_back(
    state: &ServeState,
    mark: &CommitMark,
    script: &str,
) -> Result<SetBack, StaleCompletion> {
    if !state.in_flight.as_ref().is_some_and(|f| f.is(mark, script)) {
        return Err(StaleCompletion);
    }
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
    Ok(SetBack {
        state: ServeState {
            epoch: state.epoch,
            hosts,
            kept_previous: state.kept_previous.clone(),
            in_flight: None,
        },
        reverted,
        delete_script,
    })
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
///
/// `release` is the rollback's own release state, as for [`commit_live`]. While a flight is open, the same rollback
/// asked again (the flight's script is the kept one) is a retry, and replays its first answer; anything else in flight
/// refuses it.
///
/// `release_id` is the rollback's own record. While a flight to the kept script is open, only that same record's retry,
/// under the flight's epoch, replays; another rollback record is refused `release_in_flight`, and an ended one
/// `release_ended`, as [`commit_live`] decides.
pub fn rollback(
    state: &ServeState,
    release_epoch: u64,
    kept_exists: bool,
    release_id: &str,
    release: ReleaseState,
) -> Result<(ServeState, CommitMark), RollbackRefusal> {
    if let Some(flight) = &state.in_flight {
        if state.kept_previous.as_deref() == Some(flight.script.as_str()) {
            return commit_live(state, release_epoch, &flight.script, release_id, release)
                .map_err(RollbackRefusal::Commit);
        }
        return Err(RollbackRefusal::Commit(CommitLiveRefusal::InFlight));
    }
    let kept = state
        .kept_previous
        .clone()
        .filter(|_| kept_exists)
        .ok_or(RollbackRefusal::NotKept)?;
    commit_live(state, release_epoch, &kept, release_id, release).map_err(RollbackRefusal::Commit)
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
    /// An operator took the ability to release from the room's organization, by the release switch of decision 218
    /// ([`ReleaseSwitch`]). Never the provisioning delegation, which only refuses ([`Recheck::organization_may_provision`]).
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
/// commit, from the state's own flight. An unpublish of a room serving nothing still raises the epoch, so a release in
/// flight can't go live after it.
///
/// **It never fails.** If the epoch can't go up it is set to `u64::MAX`, which [`commit_live`] and [`rollback`] refuse
/// for ever, so the room fails closed; a version that can't go up stays at `u64::MAX`, which no commit writes.
pub fn unpublish(state: &ServeState) -> (ServeState, Vec<String>) {
    let mut delete: Vec<String> = state
        .hosts
        .iter()
        .filter_map(|h| h.script.clone())
        .collect();
    delete.extend(state.kept_previous.clone());
    if let Some(flight) = &state.in_flight {
        delete.extend(flight.mark.before.iter().flatten().cloned());
        // The flight's own script, whatever the hosts name now, so it never outlives the unpublish.
        delete.push(flight.script.clone());
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
            in_flight: None,
        },
        delete,
    )
}

/// One custom hostname's claim ending, or its name suspended, which isn't an unpublish: that host alone goes to nothing
/// and is closed, first, so its applier removes the entry before the hostname is deleted at Cloudflare, and no commit,
/// rollback or set-back writes to it again. The epoch doesn't move. `None` if there's no such host.
pub fn clear_host(state: &ServeState, host: usize) -> Option<ServeState> {
    // The default host isn't a custom hostname: it never closes. Clearing it mid-flight would make the flight's own
    // confirm stale and leave the flight open.
    if host == 0 {
        return None;
    }
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
        in_flight: state.in_flight.clone(),
    })
}

/// The script the room last confirmed served, from its own state: the default host's script as the release before an
/// in-flight commit left it (the state's own flight's mark, while its marker hasn't come back), or the default host's
/// script now when nothing is in flight. Nothing when the room is unpublished, or no release was ever confirmed. No mark
/// is taken from the caller, so a stale one can't mislead it.
pub fn confirmed_script(state: &ServeState) -> Option<String> {
    match state
        .in_flight
        .as_ref()
        .filter(|flight| flight.mark.epoch == state.epoch)
    {
        Some(flight) => flight.mark.before.first().cloned().flatten(),
        None => state
            .hosts
            .first()
            .filter(|h| !h.closed)
            .and_then(|h| h.script.clone()),
    }
}

/// A custom hostname newly claimed and reported `active` (`hostnames::routing_may_start`): that host opens on the
/// release the room last confirmed served ([`confirmed_script`]), or nothing. It takes no script from its caller: what it
/// serves comes from the room's state and its own flight, never a mark from the caller, so an unpublished room opens it
/// on nothing, and
/// between a commit and its marker it never takes the unconfirmed script. When that marker comes back,
/// [`confirm_served`] moves it to the confirmed release with every other open host; if it doesn't, the set-back leaves
/// it where it is. `None` if there's no such host, or its version can't go up.
pub fn open_host(state: &ServeState, host: usize) -> Option<ServeState> {
    // The default host isn't a custom hostname: it is never opened, as it is never cleared. Opening it mid-flight would
    // put it back on the confirmed release and make the flight's own confirm stale.
    if host == 0 {
        return None;
    }
    let target = state.hosts.get(host)?;
    let version = bump(target.version)?;
    let live = confirmed_script(state);
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
        in_flight: state.in_flight.clone(),
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
/// becomes the kept one, and the one kept before that is to be deleted ([`after_served`]); the flight ends. A closed
/// host is never written. It acts only for the commit in flight, under its epoch, while the default host still holds
/// the version and the script that commit wrote. Anything else, a late, repeated or stale success among them, is
/// [`StaleCompletion`], and changes nothing.
pub fn confirm_served(
    state: &ServeState,
    mark: &CommitMark,
    script: &str,
) -> Result<Confirmed, StaleCompletion> {
    // Only the success of the commit in flight confirms anything, or ends the flight.
    if !state.in_flight.as_ref().is_some_and(|f| f.is(mark, script)) {
        return Err(StaleCompletion);
    }
    if state.epoch != mark.epoch || state.epoch == u64::MAX {
        return Err(StaleCompletion);
    }
    // Only while the default host is still exactly what this commit wrote: a late success after a set-back, or a stale
    // one after a later release, confirms nothing. A repeated confirm finds it unchanged, and changes nothing more.
    let default_holds = matches!(
        (state.hosts.first(), mark.versions.first()),
        (Some(host), Some(Some(version)))
            if host.version == *version && !host.closed && host.script.as_deref() == Some(script)
    );
    if !default_holds {
        return Err(StaleCompletion);
    }
    let mut caught_up = Vec::new();
    let mut hosts = Vec::with_capacity(state.hosts.len());
    for (i, host) in state.hosts.iter().enumerate() {
        if host.closed || host.script.as_deref() == Some(script) {
            hosts.push(host.clone());
            continue;
        }
        // Unreachable in practice: a version can't bump only at u64::MAX - 1, which no commit writes.
        let version = bump(host.version).ok_or(StaleCompletion)?;
        caught_up.push(i);
        hosts.push(DesiredServe {
            script: Some(script.to_owned()),
            version,
            closed: false,
        });
    }
    let previous = mark.before.first().cloned().flatten();
    let after = after_served(state, previous.as_deref(), script);
    Ok(Confirmed {
        state: ServeState {
            epoch: state.epoch,
            hosts,
            kept_previous: after.kept_previous.clone(),
            in_flight: None,
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
// The operator's release switch (decision 218)
// ---------------------------------------------------------------------------------------------------------------------

/// An organization's release switch, as its own `Principal` holds it, and as a room last applied it. An operator sets
/// it; taking it away unpublishes every room's app in the organization ([`UnpublishTrigger::ReleaseTakenFromOrganization`])
/// and giving it back restores nothing. Every set raises the generation, whether it takes or gives, so the newer of two
/// answers is always the one with the higher generation, and a late or repeated one can't act on a newer state.
///
/// **It carries the generation of the last take as well as the current one.** A room that missed a take, because the
/// notice was late or never sent to it, and then hears a later give-back, must still come down: giving release back
/// never restores what was served. So a room unpublishes whenever a take happened after the generation it last applied,
/// whatever the current value says ([`apply_release_switch`]). *Added after the reviews of PR #344, where the first rule
/// left such a room up, so the outcome depended on the order notices arrived in.*
///
/// Well formed ([`ReleaseSwitch::well_formed`]): while release is taken the last take is the current generation; while
/// it is held the last take is earlier, or the switch is unset.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReleaseSwitch {
    pub granted: bool,
    pub generation: u64,
    /// The generation of the most recent take, or 0 if release was never taken from the organization.
    pub last_take: u64,
}

impl ReleaseSwitch {
    /// An organization nobody has set it for holds it, at generation 0, never taken.
    pub const UNSET: ReleaseSwitch = ReleaseSwitch {
        granted: true,
        generation: 0,
        last_take: 0,
    };

    /// Whether the switch's own fields agree, as only [`ReleaseSwitch::set`] from [`ReleaseSwitch::UNSET`] makes them:
    /// taken means taken at this generation, which is above 0; held means the last take was before this generation, or
    /// the switch is still unset.
    pub fn well_formed(self) -> bool {
        if self.granted {
            self.last_take < self.generation || self == ReleaseSwitch::UNSET
        } else {
            self.generation > 0 && self.last_take == self.generation
        }
    }

    /// An operator's set, to `granted`. Setting it to what it already is raises the generation too, so asking again is
    /// a new notice to every room and never silently nothing; a take, even a repeated one, is the new last take. `None`
    /// when the generation can't go up: the set is then refused, loudly, rather than written at a generation no room
    /// would take as newer.
    pub fn set(self, granted: bool) -> Option<ReleaseSwitch> {
        let generation = self.generation.checked_add(1)?;
        Some(ReleaseSwitch {
            granted,
            generation,
            last_take: if granted { self.last_take } else { generation },
        })
    }

    /// What a new room starts from: the organization's switch as it read it while being made, so a take before the
    /// room existed has nothing of this room's to unpublish, and a later give-back only records. A room that couldn't
    /// read it, or read something malformed, starts from [`ReleaseSwitch::UNSET`] instead, which fails closed: any take
    /// the organization ever made is then newer than what it applied, so its first answer unpublishes it, which for a
    /// room with nothing up only raises its epoch. A room made before the switch existed starts there too.
    pub fn start_for_room(read_at_creation: Option<ReleaseSwitch>) -> ReleaseSwitch {
        read_at_creation
            .filter(|s| s.well_formed())
            .unwrap_or(ReleaseSwitch::UNSET)
    }
}

/// What a room does with an answer about its organization's release switch, whether a notice the organization's object
/// sent or the room's own read of that object, at a release command or on the reconcile's walk. Both paths take this,
/// and the outcome depends only on the newest answer the room has had, not on which others arrived or in what order;
/// so a room missing from the organization's list of rooms ends where the notices would have put it, once it reads.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SwitchApplied {
    /// Not newer than what the room last applied: a notice is acknowledged and nothing changes.
    Stale,
    /// Newer, and no take happened since what the room last applied: the room records the switch and restores nothing.
    Record,
    /// Newer, and a take happened since what the room last applied, whether or not release has been given back since:
    /// the room records the switch and unpublishes ([`unpublish`]) with [`UnpublishTrigger::ReleaseTakenFromOrganization`],
    /// in one transaction. A room with nothing up still does, so its epoch goes up and nothing in flight can go live
    /// after it.
    Unpublish,
    /// The answer, or what the room last applied, isn't well formed: nothing changes and a notice is not acknowledged,
    /// so it is kept and logged by its IDs, never dropped as if it had been applied. A room whose own applied switch is
    /// malformed can't tell what is newer, so it decides nothing until that is put right; its recheck is undecided too
    /// ([`release_switch_now`]). *Added after the delta review of PR #344.*
    Refused,
}

/// Decides [`SwitchApplied`] from what the room last applied and the answer it now has.
pub fn apply_release_switch(applied: ReleaseSwitch, seen: ReleaseSwitch) -> SwitchApplied {
    if !seen.well_formed() || !applied.well_formed() {
        SwitchApplied::Refused
    } else if seen.generation <= applied.generation {
        SwitchApplied::Stale
    } else if seen.last_take > applied.generation {
        SwitchApplied::Unpublish
    } else {
        SwitchApplied::Record
    }
}

/// The switch as the recheck takes it: the newer of what the room last applied and what it just read. `None` when the
/// read couldn't be made, which is undecided, never "taken" and never "held": the pass answers `standing_unknown`. A read
/// older than what the room applied, a reply overtaken by a newer notice, gives way to what the room applied. Two
/// answers at the same generation that disagree, or either one malformed, are undecided too: `None`.
pub fn release_switch_now(
    applied: ReleaseSwitch,
    read: Option<ReleaseSwitch>,
) -> Option<ReleaseSwitch> {
    let read = read.filter(|r| r.well_formed())?;
    if !applied.well_formed() {
        return None;
    }
    match read.generation.cmp(&applied.generation) {
        std::cmp::Ordering::Greater => Some(read),
        std::cmp::Ordering::Less => Some(applied),
        std::cmp::Ordering::Equal => (read == applied).then_some(read),
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// The job's recheck, on every pass
// ---------------------------------------------------------------------------------------------------------------------

/// What the job rechecks on every pass, and the room again inside the transaction that commits a release live. Each
/// field is read from current state; the policy answers come from `podster_policy::release`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Recheck<'a> {
    pub room: RoomReleaseFacts,
    /// The organization holds M5's provisioning delegation. It only refuses a release, with
    /// [`RecheckFailure::ProvisioningNotDelegated`]; it is never an unpublish trigger (decision 218, part 1). The release
    /// switch that unpublishes is `room.organization_may_release`.
    pub organization_may_provision: bool,
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
    /// `release_not_delegated`, the same code on the wire as [`UnpublishTrigger::ReleaseTakenFromOrganization`]: the
    /// organization's provisioning delegation was taken back. It refuses only. [`RecheckFailure::not_delegated_cause`]
    /// tells the two apart where operators look.
    ProvisioningNotDelegated,
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
            RecheckFailure::ProvisioningNotDelegated => "release_not_delegated",
            RecheckFailure::ConfigChanged => "release_config_changed",
            RecheckFailure::RequesterLostAuthority => "requester_lost_authority",
            RecheckFailure::ApproverLostAuthority => "approver_lost_authority",
            RecheckFailure::ReviewerRuleChanged => "reviewer_rule_changed",
            RecheckFailure::Commit(refusal) => refusal.code(),
            RecheckFailure::EpochMoved => CommitLiveRefusal::EpochMoved.code(),
        }
    }

    /// Which fact refused, for a failure answered `release_not_delegated`; `None` for every other. The wire code is the
    /// same for both causes, so the audit record and any finding keep this one too (the architect's ruling on decision
    /// 218's switch, 2026-11-13).
    pub fn not_delegated_cause(self) -> Option<NotDelegatedCause> {
        match self {
            RecheckFailure::Trigger(UnpublishTrigger::ReleaseTakenFromOrganization) => {
                Some(NotDelegatedCause::ReleaseSwitch)
            }
            RecheckFailure::ProvisioningNotDelegated => {
                Some(NotDelegatedCause::ProvisioningDelegation)
            }
            _ => None,
        }
    }
}

/// Which of an organization's two facts refused a release that was answered `release_not_delegated`. Kept in the
/// release's audit record and in operators' findings, never on the wire.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NotDelegatedCause {
    /// `release_switch`: an operator took release from the organization (decision 218's switch). It unpublishes.
    ReleaseSwitch,
    /// `provisioning_delegation`: an operator took M5's provisioning delegation back. It only refuses.
    ProvisioningDelegation,
}

impl NotDelegatedCause {
    // codes: reasons
    pub fn code(self) -> &'static str {
        match self {
            NotDelegatedCause::ReleaseSwitch => "release_switch",
            NotDelegatedCause::ProvisioningDelegation => "provisioning_delegation",
        }
    }
}

/// The whole recheck, in the ADR's order: deployment and stop, the organization (gone, its release switch, then its
/// provisioning delegation), the room, the repository, the room's
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
    let fired = unpublish_triggers(&r.room);
    let organization = [
        UnpublishTrigger::OrganizationDeleted,
        UnpublishTrigger::ReleaseTakenFromOrganization,
    ];
    if let Some(trigger) = organization.iter().find(|t| fired.contains(t)) {
        return Err(RecheckFailure::Trigger(*trigger));
    }
    if !r.organization_may_provision {
        return Err(RecheckFailure::ProvisioningNotDelegated);
    }
    let order = [
        UnpublishTrigger::RoomDeleted,
        UnpublishTrigger::RoomMadePrivate,
        UnpublishTrigger::RoomArchived,
        UnpublishTrigger::PublicSurfaceSuspended,
        UnpublishTrigger::AppSuspended,
        UnpublishTrigger::RepositoryNotReady,
        UnpublishTrigger::ReleaseOffInRoom,
    ];
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

/// Why the room ends a release whose upload it had started, apart from the recheck's own reasons and a refused commit.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UploadFailure {
    /// `release_upload_expired`: it was still uploading, or its upload still uncertain, an hour after it started
    /// ([`IN_FLIGHT_EXEMPTION_MS`]). Its script no longer has the reconcile's exemption, so it never goes live.
    Expired,
    /// `release_script_deleted`: its script was queued for deletion, by the reconcile or anything else. A script that
    /// may be gone is never set as what a host serves.
    ScriptDeleted,
    /// `release_label_retired`: the label it was asked under is no longer the room's current one.
    LabelRetired,
}

impl UploadFailure {
    // codes: reasons
    pub fn code(self) -> &'static str {
        match self {
            UploadFailure::Expired => "release_upload_expired",
            UploadFailure::ScriptDeleted => "release_script_deleted",
            UploadFailure::LabelRetired => "release_label_retired",
        }
    }
}

/// Whether an upload that started at `since` has outlived its hour at `now`: the same bound the reconcile keeps a
/// script for ([`reconcile_script`]), so a release is failed exactly when its script stops being kept.
pub fn upload_expired(since: i64, now: i64) -> bool {
    now.saturating_sub(since) >= IN_FLIGHT_EXEMPTION_MS
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

/// The deployment's read budget, asked by one release (M6 step 9). `held` is every other release's reservation as
/// `(reserved_at, reads)`, in any order; one reserved before the rolling hour at `now` no longer counts. `Ok` when
/// `needed` fits now. Otherwise the earliest time it would fit if nothing else were reserved meanwhile, which is when
/// enough of the oldest reservations leave the hour, or `None` when it never fits, since `needed` alone is past the
/// budget.
pub fn read_budget_wait(held: &[(i64, u32)], needed: u32, now: i64) -> Result<(), Option<i64>> {
    if needed > MAX_RELEASE_READS_PER_HOUR {
        return Err(None);
    }
    let start = window_start(now, READ_WINDOW_MS);
    let mut counting: Vec<(i64, u32)> = held
        .iter()
        .copied()
        .filter(|(at, _)| *at >= start)
        .collect();
    let mut used = counting
        .iter()
        .fold(0u32, |sum, (_, reads)| sum.saturating_add(*reads));
    if reads_fit(used, needed).is_ok() {
        return Ok(());
    }
    // Oldest first: each leaves the hour at its own time plus the window, and the release fits once enough have left.
    counting.sort_unstable();
    for (at, reads) in counting {
        used = used.saturating_sub(reads);
        if reads_fit(used, needed).is_ok() {
            return Err(Some(at.saturating_add(READ_WINDOW_MS)));
        }
    }
    // Every reservation has left by then, and `needed` alone fits, so the loop always answered.
    Err(None)
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
