//! Provisioning a room's managed repository (M5 step 4, ADR 0009, which is proposed). No I/O.
//!
//! The job that talks to the provider lives in the API. What it may conclude from the provider's answers is decided
//! here: how a creation call's answer is read, what setup may still add to a repository Podster made, and whether what was
//! read back is exactly what readiness needs. Everything fails closed. A rule that's present and wrong is never repaired
//! and never accepted, and a repository is only ever known by the ID in the provider's answer to Podster's own creation
//! call, never by its name.

/// The status the merge App sets on a reviewed commit, and the review ruleset requires.
pub const STATUS_CONTEXT: &str = "podster/review";
/// A ruleset's condition for the default branch, as the provider writes it.
pub const DEFAULT_BRANCH_REF: &str = "~DEFAULT_BRANCH";
/// How many hex digits the server adds to a name on a retry.
pub const RETRY_SUFFIX_DIGITS: usize = 6;

/// How many times setup may run for one room's request: the first run and four retries. Past that a retry is refused
/// until an operator resets it, which isn't built yet.
pub const MAX_SETUP_RUNS: i64 = 5;
/// How long one request may stay pending while GitHub rate-limits it, from its first limited attempt: a day. Each limit
/// waits the time GitHub gave and spends no run (the M5 security review's F5). Past this the request ends `failed` as
/// [`RATE_LIMITED_REASON`], still without spending a run, and a retry's first call waits for the last reset GitHub gave.
pub const RATE_LIMITED_FOR_MS: i64 = 24 * 60 * 60 * 1000;
/// The reason a request ends with once it has been rate-limited for [`RATE_LIMITED_FOR_MS`].
pub const RATE_LIMITED_REASON: &str = "provider_rate_limited";

/// Whether a run GitHub rate-limited waits, given when the request was first limited (`limited_since`, or `None` if
/// this is the first). Bounded by elapsed time, not by how many limits came, so short waits can't end it early.
pub fn rate_limited_run_waits(limited_since: Option<i64>, now: i64) -> bool {
    limited_since.is_none_or(|since| now.saturating_sub(since) < RATE_LIMITED_FOR_MS)
}

/// The wait before setup reads a repository it just created again, when GitHub answered that it isn't there. A new
/// repository can take a moment to show by its ID, so setup never fails on that alone.
pub const SETUP_GONE_WAIT_MS: i64 = 60 * 1000;
/// How many such waits in a row before the run fails as `read_back_failed`, never `repository_gone`.
pub const SETUP_GONE_WAITS: i64 = 10;

/// How often a linked repository's protections and settings are read back when nothing else reads them (ADR 0009's
/// "on a schedule", and the M5 security review's F8): a day after the last read that found them exactly right.
/// Proposed. A merge reads them too, before it's asked for.
pub const READINESS_INTERVAL_MS: i64 = 24 * 60 * 60 * 1000;
/// After a scheduled read that couldn't be made, or found nothing definite, the next waits this long.
pub const READINESS_RETRY_MS: i64 = 60 * 60 * 1000;

/// When a ready link is next due its scheduled read-back: [`READINESS_INTERVAL_MS`] after it was last found exactly
/// right, and never sooner than [`READINESS_RETRY_MS`] after the last scheduled attempt, whatever came of it. A
/// repository seen gone (`gone_seen_at`) is looked at again [`GONE_CONFIRM_MS`] later, and never sooner than that after
/// the last attempt, so a second look that can't be made doesn't bring the alarm straight back.
pub fn readiness_due_at(
    verified_at: i64,
    last_attempt_at: Option<i64>,
    gone_seen_at: Option<i64>,
) -> i64 {
    let after_last = |wait: i64| last_attempt_at.map_or(i64::MIN, |at| at.saturating_add(wait));
    match gone_seen_at {
        Some(seen) => seen
            .saturating_add(GONE_CONFIRM_MS)
            .max(after_last(GONE_CONFIRM_MS)),
        None => verified_at
            .saturating_add(READINESS_INTERVAL_MS)
            .max(after_last(READINESS_RETRY_MS)),
    }
}

/// The wait before a retry is taken: a minute after the first run, doubling, up to an hour.
pub const RETRY_WAIT_MIN_MS: i64 = 60 * 1000;
pub const RETRY_WAIT_MAX_MS: i64 = 60 * 60 * 1000;
/// When the job itself can't finish, the alarm comes back for it after 5 seconds, doubling, up to 5 minutes.
pub const JOB_BACKOFF_MIN_MS: i64 = 5 * 1000;
pub const JOB_BACKOFF_MAX_MS: i64 = 5 * 60 * 1000;

/// Names nobody may ask for in an organization every room shares: ones that would read as Podster's own, or as the
/// organization's own pages. Proposed, and listed in the M5 plan.
pub const RESERVED_NAMES: [&str; 12] = [
    "podster",
    "podsterdev",
    "security",
    "admin",
    "api",
    "www",
    "docs",
    "status",
    "support",
    "billing",
    "legal",
    "abuse",
];
/// A name starting with this would read as one of Podster's own repositories.
pub const RESERVED_PREFIX: &str = "podster-";

/// Whether a name is held back, whatever its case. A name starting with a dot is too, though `valid_repo_name` already
/// refuses those.
pub fn reserved_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.starts_with('.')
        || lower.starts_with(RESERVED_PREFIX)
        || RESERVED_NAMES.contains(&lower.as_str())
}

/// How long after run number `runs` ended a retry must wait.
pub fn retry_wait_ms(runs: i64) -> i64 {
    let doublings = (runs - 1).clamp(0, 16) as u32;
    RETRY_WAIT_MIN_MS
        .checked_shl(doublings)
        .map_or(RETRY_WAIT_MAX_MS, |wait| {
            wait.clamp(RETRY_WAIT_MIN_MS, RETRY_WAIT_MAX_MS)
        })
}

/// Why a retry isn't taken yet, or any more.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RetryHeld {
    /// `retry_limit_reached`: setup has run as often as it may.
    LimitReached,
    /// `retry_too_soon`: the wait since the last run isn't over.
    TooSoon,
}

impl RetryHeld {
    // codes: errors
    pub fn code(self) -> &'static str {
        match self {
            RetryHeld::LimitReached => "retry_limit_reached",
            RetryHeld::TooSoon => "retry_too_soon",
        }
    }
}

/// Whether a retry may be taken now: `runs` is how often setup has run, and `retry_after` when the last run said the
/// next may start. The limit is checked first, since no wait ends it.
pub fn retry_allowed(runs: i64, retry_after: Option<i64>, now: i64) -> Result<(), RetryHeld> {
    if runs >= MAX_SETUP_RUNS {
        Err(RetryHeld::LimitReached)
    } else if retry_after.is_some_and(|after| now < after) {
        Err(RetryHeld::TooSoon)
    } else {
        Ok(())
    }
}

/// How long the alarm stays away after the job failed to finish `failures` times in a row.
pub fn job_backoff_ms(failures: u32) -> i64 {
    JOB_BACKOFF_MIN_MS
        .checked_shl(failures.saturating_sub(1).min(16))
        .map_or(JOB_BACKOFF_MAX_MS, |wait| {
            wait.clamp(JOB_BACKOFF_MIN_MS, JOB_BACKOFF_MAX_MS)
        })
}

/// How a creation call ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Creation {
    /// The provider answered that it made the repository. Its ID is in the answer.
    Created,
    /// The provider refused the name as taken. Nothing was made by this call.
    NameTaken,
    /// The provider refused the call. Nothing was made by this call.
    Refused,
    /// The provider limited how fast Podster may call it (`crate::rate_limit`). Nothing was made by this call, and it
    /// says nothing about the request: the run isn't spent, and the same name is sent again after the wait.
    RateLimited,
    /// Nobody knows: no answer, a server error, or an answer that can't be read. A repository may exist.
    Unknown,
}

/// Reads a creation call's outcome from its HTTP status, if one came back. `name_error` says the provider's answer blamed
/// the name, `has_id` that a created answer carried a repository ID, and `rate_limited` that the answer was a rate limit
/// by `crate::rate_limit::rate_limit_wait_ms`, which comes before the status: a limit is a `403` or `429` too.
pub fn classify_creation(
    status: Option<u16>,
    name_error: bool,
    has_id: bool,
    rate_limited: bool,
) -> Creation {
    match status {
        Some(403 | 429) if rate_limited => Creation::RateLimited,
        Some(201) if has_id => Creation::Created,
        Some(422) if name_error => Creation::NameTaken,
        // A client error says the call was understood and refused, so nothing was made.
        Some(400..=499) => Creation::Refused,
        _ => Creation::Unknown,
    }
}

/// The permissions provisioning asks for on each of its tokens, and the only ones it accepts back: the provisioning
/// App's own, Administration to write and Metadata to read (ADR 0009). Asking names them, so a later change to the
/// App's permissions can't widen these tokens unseen (the M5 security review's F4).
pub const PROVISIONING_PERMISSIONS: [(&str, &str); 2] =
    [("administration", "write"), ("metadata", "read")];
/// The one token provisioning asks for across the whole installation besides the creation call's: Metadata to read and
/// nothing else, to ask whether a repository a narrowed token couldn't be minted for is there at all.
pub const PRESENCE_PERMISSIONS: [(&str, &str); 1] = [("metadata", "read")];
/// GitHub's installation tokens expire one hour after they're made. A minute more allows for clocks.
pub const TOKEN_LIFE_MAX_MS: i64 = 61 * 60 * 1000;

/// Whether a token provisioning was given is the one it asked for, before it's used: exactly
/// [`PROVISIONING_PERMISSIONS`], expiring within [`TOKEN_LIFE_MAX_MS`] and not already, and, when it was narrowed to
/// one repository, reaching that repository and no other. The creation token can't be narrowed, since its repository
/// doesn't exist yet, so `narrowed_to` is `None` and the answer's repositories aren't judged.
pub fn provisioning_token_matches(
    narrowed_to: Option<i64>,
    answer_repo_ids: &[i64],
    answer_permissions: &[(&str, &str)],
    expires_at: Option<i64>,
    now: i64,
) -> bool {
    token_answer_matches(
        narrowed_to,
        answer_repo_ids,
        answer_permissions,
        &PROVISIONING_PERMISSIONS,
        expires_at,
        now,
    )
}

/// The same check, for a token that asked for `asked`.
pub fn token_answer_matches(
    narrowed_to: Option<i64>,
    answer_repo_ids: &[i64],
    answer_permissions: &[(&str, &str)],
    asked: &[(&str, &str)],
    expires_at: Option<i64>,
    now: i64,
) -> bool {
    let scoped = narrowed_to.is_none_or(|repo_id| answer_repo_ids == [repo_id]);
    let exact = answer_permissions.len() == asked.len()
        && asked.iter().all(|pair| answer_permissions.contains(pair));
    let fresh = expires_at.is_some_and(|at| at > now && at <= now + TOKEN_LIFE_MAX_MS);
    scoped && exact && fresh
}

/// The name a retry sends: the chosen name with a suffix the server generated, kept within the limit. `None` if the suffix
/// isn't exactly the hex digits expected, or the result isn't a name a repository may have.
pub fn retry_name(chosen: &str, suffix: &str) -> Option<String> {
    let hex = suffix.len() == RETRY_SUFFIX_DIGITS
        && suffix
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    if !hex {
        return None;
    }
    let room = crate::repositories::MAX_REPO_NAME_BYTES - RETRY_SUFFIX_DIGITS - 1;
    let stem: String = chosen.chars().take(room).collect();
    let name = format!("{}-{suffix}", stem.trim_end_matches('-'));
    crate::repositories::valid_repo_name(&name).then_some(name)
}

/// What Podster expects of a repository it made.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Expected {
    /// The repository ID from the creation answer.
    pub repo_id: i64,
    /// The configured organization's ID.
    pub org_id: i64,
    /// The merge App's ID: the one bypass actor of the update ruleset, and the only source of the required status.
    pub merge_app_id: i64,
    pub public: bool,
}

/// One actor on a ruleset's bypass list, as read back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Bypass {
    pub actor_id: Option<i64>,
    pub actor_type: String,
    pub mode: String,
}

/// One ruleset, as read back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ruleset {
    pub enforcement: String,
    pub target: String,
    pub include: Vec<String>,
    pub exclude: Vec<String>,
    /// The type of each rule in it.
    pub rule_types: Vec<String>,
    /// Each required status: its context, and the App that must set it.
    pub required_statuses: Vec<(String, Option<i64>)>,
    /// `None` if the answer carried no bypass list, which is how a token that can't see it reads.
    pub bypass: Option<Vec<Bypass>>,
}

/// The repository's own settings that bear on what strangers and agents can do, as read back. Podster asks for every
/// one of these off at creation (the M5 security review's F7 and F8). A public repository can't forbid forks: GitHub
/// lets anyone fork a public repository whatever its settings, so forking isn't read or judged here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RepoSettings {
    pub has_issues: bool,
    pub has_wiki: bool,
    pub has_projects: bool,
    pub has_discussions: bool,
    /// `None` when the answer didn't carry it. GitHub documents that merge settings show only to a token that can read
    /// and write contents, which provisioning's can't, so its absence is no difference. A value that's there is judged.
    pub allow_auto_merge: Option<bool>,
    /// The same.
    pub delete_branch_on_merge: Option<bool>,
}

impl RepoSettings {
    /// What Podster asks for at creation: issues, wiki, projects and discussions off, auto-merge off, and branches
    /// kept after a merge, which is GitHub's default and needs no organization owner to set.
    pub const EXPECTED: RepoSettings = RepoSettings {
        has_issues: false,
        has_wiki: false,
        has_projects: false,
        has_discussions: false,
        allow_auto_merge: Some(false),
        delete_branch_on_merge: Some(false),
    };

    fn as_expected(self) -> bool {
        let e = RepoSettings::EXPECTED;
        self.has_issues == e.has_issues
            && self.has_wiki == e.has_wiki
            && self.has_projects == e.has_projects
            && self.has_discussions == e.has_discussions
            && self
                .allow_auto_merge
                .is_none_or(|v| Some(v) == e.allow_auto_merge)
            && self
                .delete_branch_on_merge
                .is_none_or(|v| Some(v) == e.delete_branch_on_merge)
    }
}

/// The repository's default permissions for a workflow's token, as read back. Actions are off, so no workflow runs, but
/// a repository whose Actions are switched back on mustn't start with workflows that can write or approve.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkflowPermissions {
    /// GitHub's `default_workflow_permissions`: `read` or `write`.
    pub default: String,
    pub can_approve_pull_request_reviews: bool,
}

impl WorkflowPermissions {
    fn as_expected(&self) -> bool {
        self.default == "read" && !self.can_approve_pull_request_reviews
    }
}

/// Everything read back about a repository.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Observed {
    /// False when the read showed, definitely, that the repository isn't there ([`repository_gone`]). Nothing else read
    /// then means anything.
    pub present: bool,
    pub repo_id: i64,
    pub owner_id: i64,
    pub private: bool,
    pub archived: bool,
    pub default_branch_has_commit: bool,
    /// `None` if the setting couldn't be read.
    pub actions_enabled: Option<bool>,
    pub settings: RepoSettings,
    pub workflow: WorkflowPermissions,
    pub rulesets: Vec<Ruleset>,
}

/// Why a repository isn't ready. Each is a reason code the room's people see.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotReady {
    /// The repository isn't there any more: deleted, or out of the installation's reach (see [`repository_gone`]).
    RepositoryGone,
    WrongRepository,
    WrongOwner,
    VisibilityDiffers,
    Archived,
    NoInitialCommit,
    ActionsEnabled,
    ActionsUnreadable,
    RulesetMissing,
    RulesetInactive,
    RulesetDiffers,
    BypassDiffers,
    UnexpectedRuleset,
    /// Issues, wiki, projects, discussions, auto-merge or branch deletion differ from what creation asked for.
    SettingsDiffer,
    /// Workflows' default token can write, or approve pull requests.
    WorkflowPermissionsDiffer,
}

impl NotReady {
    // codes: reasons
    pub fn code(self) -> &'static str {
        match self {
            NotReady::RepositoryGone => "repository_gone",
            NotReady::WrongRepository => "wrong_repository",
            NotReady::WrongOwner => "wrong_owner",
            NotReady::VisibilityDiffers => "visibility_differs",
            NotReady::Archived => "archived",
            NotReady::NoInitialCommit => "no_initial_commit",
            NotReady::ActionsEnabled => "actions_enabled",
            NotReady::ActionsUnreadable => "actions_unreadable",
            NotReady::RulesetMissing => "ruleset_missing",
            NotReady::RulesetInactive => "ruleset_inactive",
            NotReady::RulesetDiffers => "ruleset_differs",
            NotReady::BypassDiffers => "bypass_differs",
            NotReady::UnexpectedRuleset => "unexpected_ruleset",
            NotReady::SettingsDiffer => "settings_differ",
            NotReady::WorkflowPermissionsDiffer => "workflow_permissions_differ",
        }
    }
}

/// Something setup may add to a repository Podster made. Setup only ever adds what's missing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SetupStep {
    DisableActions,
    /// Workflows' default token reads only, and can't approve pull requests.
    RestrictWorkflowPermissions,
    /// A pull request and the required status from the merge App, with no bypass actor.
    CreateReviewRuleset,
    /// No update of the default branch, with the merge App as the only bypass actor.
    CreateUpdateRuleset,
}

#[derive(PartialEq, Eq)]
enum Kind {
    Review,
    Update,
}

fn kind(ruleset: &Ruleset) -> Option<Kind> {
    let mut types: Vec<&str> = ruleset.rule_types.iter().map(String::as_str).collect();
    types.sort_unstable();
    match types.as_slice() {
        ["pull_request", "required_status_checks"] => Some(Kind::Review),
        ["update"] => Some(Kind::Update),
        _ => None,
    }
}

/// Whether one of the two rulesets is exactly as it must be.
fn check_ruleset(ruleset: &Ruleset, kind: &Kind, expected: &Expected) -> Result<(), NotReady> {
    if ruleset.enforcement != "active" {
        return Err(NotReady::RulesetInactive);
    }
    if ruleset.target != "branch"
        || ruleset.include.len() != 1
        || ruleset.include.first().map(String::as_str) != Some(DEFAULT_BRANCH_REF)
        || !ruleset.exclude.is_empty()
    {
        return Err(NotReady::RulesetDiffers);
    }
    // A list that can't be seen is a list that can't be vouched for.
    let bypass = ruleset.bypass.as_ref().ok_or(NotReady::BypassDiffers)?;
    match kind {
        Kind::Review => {
            let pinned = ruleset.required_statuses.len() == 1
                && ruleset.required_statuses.first()
                    == Some(&(STATUS_CONTEXT.to_string(), Some(expected.merge_app_id)));
            if !pinned {
                return Err(NotReady::RulesetDiffers);
            }
            if !bypass.is_empty() {
                return Err(NotReady::BypassDiffers);
            }
        }
        Kind::Update => {
            let only_merge_app = bypass.len() == 1
                && bypass.first().is_some_and(|actor| {
                    actor.actor_id == Some(expected.merge_app_id)
                        && actor.actor_type == "Integration"
                        && actor.mode == "always"
                });
            if !only_merge_app {
                return Err(NotReady::BypassDiffers);
            }
        }
    }
    Ok(())
}

/// Whether an answer says, definitely, that the repository is gone (the lead's ruling of 2026-11-11 on takedowns).
///
/// GitHub's "Get a repository" documents `404` for a repository that doesn't exist or that the token can't see, and
/// `301` for one that moved, which isn't this. A repository deleted on GitHub answers `404` by its ID. Only a `404` to a
/// token that was minted successfully just before, for Podster's own installation, is definite: then the key, the
/// installation and the rate limit were all fine a moment ago, and the installation no longer reaches the repository,
/// whether it was deleted or taken out of the installation by hand. Anything else (no token, a refusal, a limit, a
/// server's error) says nothing about the repository and still waits.
pub fn repository_gone(token_minted: bool, status: u16) -> bool {
    token_minted && status == 404
}

/// How long after a repository was first seen gone a second look must come before the link is degraded.
pub const GONE_CONFIRM_MS: i64 = 60 * 1000;

/// What one more "gone" answer means, given when the repository was first seen gone since it last read back right.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GoneLook {
    /// The first: record when, and wait. Nothing changes yet.
    FirstSeen,
    /// Seen before, less than [`GONE_CONFIRM_MS`] ago: wait for a later look.
    TooSoon,
    /// Seen again a minute or more after the first, with no read that found it in between: it's gone.
    Confirmed,
}

/// A first sighting older than this is no sighting: one `404`, then a long stretch with nothing read, then one more
/// never adds up to "gone". Proposed.
pub const GONE_SIGHTING_MAX_AGE_MS: i64 = 60 * 60 * 1000;

/// Two definite answers at least [`GONE_CONFIRM_MS`] apart, and within [`GONE_SIGHTING_MAX_AGE_MS`] of each other,
/// make a repository gone (ruled by the architect, 2026-11-11). The caller clears the first sighting on any other
/// outcome of a later look, so the confirming look either degrades or clears it.
pub fn gone_look(first_seen_at: Option<i64>, now: i64) -> GoneLook {
    match first_seen_at {
        None => GoneLook::FirstSeen,
        Some(at) if now.saturating_sub(at) > GONE_SIGHTING_MAX_AGE_MS => GoneLook::FirstSeen,
        Some(at) if now.saturating_sub(at) < GONE_CONFIRM_MS => GoneLook::TooSoon,
        Some(_) => GoneLook::Confirmed,
    }
}

/// The read-back of a repository [`repository_gone`] says isn't there: nothing in it but its ID.
pub fn gone(repo_id: i64) -> Observed {
    Observed {
        present: false,
        repo_id,
        owner_id: 0,
        private: false,
        archived: false,
        default_branch_has_commit: false,
        actions_enabled: None,
        settings: RepoSettings::EXPECTED,
        workflow: WorkflowPermissions {
            default: String::new(),
            can_approve_pull_request_reviews: false,
        },
        rulesets: vec![],
    }
}

/// What setup still has to add, or why this repository can't be made ready. Anything present and wrong is a refusal:
/// setup never edits or removes a rule, so a rule someone changed is seen and not papered over.
pub fn missing_steps(expected: &Expected, observed: &Observed) -> Result<Vec<SetupStep>, NotReady> {
    if !observed.present {
        return Err(NotReady::RepositoryGone);
    }
    if observed.repo_id != expected.repo_id {
        return Err(NotReady::WrongRepository);
    }
    if observed.owner_id != expected.org_id {
        return Err(NotReady::WrongOwner);
    }
    if observed.private == expected.public {
        return Err(NotReady::VisibilityDiffers);
    }
    if observed.archived {
        return Err(NotReady::Archived);
    }
    if !observed.default_branch_has_commit {
        return Err(NotReady::NoInitialCommit);
    }
    // Creation asked for these. One that differs was changed by someone with admin rights, or GitHub didn't take it,
    // and setup never edits a repository's settings to paper over either.
    if !observed.settings.as_expected() {
        return Err(NotReady::SettingsDiffer);
    }
    let mut steps = vec![];
    match observed.actions_enabled {
        None => return Err(NotReady::ActionsUnreadable),
        Some(true) => steps.push(SetupStep::DisableActions),
        Some(false) => {}
    }
    // An organization's default may give workflows write. Setup narrows it, as it switches Actions off.
    if !observed.workflow.as_expected() {
        steps.push(SetupStep::RestrictWorkflowPermissions);
    }
    let mut review = false;
    let mut update = false;
    for ruleset in &observed.rulesets {
        let found = kind(ruleset).ok_or(NotReady::UnexpectedRuleset)?;
        let seen = match found {
            Kind::Review => &mut review,
            Kind::Update => &mut update,
        };
        // A second ruleset of a kind is one Podster didn't make.
        if *seen {
            return Err(NotReady::UnexpectedRuleset);
        }
        *seen = true;
        check_ruleset(ruleset, &found, expected)?;
    }
    if !review {
        steps.push(SetupStep::CreateReviewRuleset);
    }
    if !update {
        steps.push(SetupStep::CreateUpdateRuleset);
    }
    Ok(steps)
}

/// Whether what was read back is exactly what readiness needs. Nothing missing, nothing different, nothing extra.
pub fn verify_ready(expected: &Expected, observed: &Observed) -> Result<(), NotReady> {
    match missing_steps(expected, observed)?.first() {
        None => Ok(()),
        Some(SetupStep::DisableActions) => Err(NotReady::ActionsEnabled),
        Some(SetupStep::RestrictWorkflowPermissions) => Err(NotReady::WorkflowPermissionsDiffer),
        Some(SetupStep::CreateReviewRuleset | SetupStep::CreateUpdateRuleset) => {
            Err(NotReady::RulesetMissing)
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::indexing_slicing, clippy::type_complexity)]
    use super::*;

    const EXPECTED: Expected = Expected {
        repo_id: 9001,
        org_id: 4242,
        merge_app_id: 7,
        public: true,
    };

    fn ruleset(types: &[&str]) -> Ruleset {
        Ruleset {
            enforcement: "active".to_string(),
            target: "branch".to_string(),
            include: vec![DEFAULT_BRANCH_REF.to_string()],
            exclude: vec![],
            rule_types: types.iter().map(|t| (*t).to_string()).collect(),
            required_statuses: vec![],
            bypass: Some(vec![]),
        }
    }

    fn review() -> Ruleset {
        Ruleset {
            required_statuses: vec![(STATUS_CONTEXT.to_string(), Some(7))],
            ..ruleset(&["pull_request", "required_status_checks"])
        }
    }

    fn merge_app() -> Bypass {
        Bypass {
            actor_id: Some(7),
            actor_type: "Integration".to_string(),
            mode: "always".to_string(),
        }
    }

    fn update() -> Ruleset {
        Ruleset {
            bypass: Some(vec![merge_app()]),
            ..ruleset(&["update"])
        }
    }

    fn ready() -> Observed {
        Observed {
            present: true,
            repo_id: 9001,
            owner_id: 4242,
            private: false,
            archived: false,
            default_branch_has_commit: true,
            actions_enabled: Some(false),
            settings: RepoSettings::EXPECTED,
            workflow: WorkflowPermissions {
                default: "read".to_string(),
                can_approve_pull_request_reviews: false,
            },
            rulesets: vec![review(), update()],
        }
    }

    #[test]
    fn names_that_would_read_as_podsters_own_are_held_back_whatever_their_case() {
        for name in RESERVED_NAMES {
            assert!(reserved_name(name), "{name}");
            assert!(reserved_name(&name.to_ascii_uppercase()), "{name}");
        }
        for name in [
            "podster-api",
            "Podster-Web",
            "PODSTER-",
            ".github",
            ".well-known",
            "Admin",
            "WWW",
        ] {
            assert!(reserved_name(name), "{name}");
        }
        for name in [
            "engineering",
            "podsters",
            "my-podster",
            "apis",
            "administer",
            "docs-site",
            "security-review",
            "a",
        ] {
            assert!(!reserved_name(name), "{name}");
        }
        // Every reserved name is otherwise one a repository could have, so the list is what refuses it.
        for name in RESERVED_NAMES {
            assert!(crate::repositories::valid_repo_name(name), "{name}");
        }
    }

    #[test]
    fn a_retry_waits_longer_each_time_and_stops_at_the_fifth_run() {
        assert_eq!(retry_wait_ms(1), 60_000);
        assert_eq!(retry_wait_ms(2), 120_000);
        assert_eq!(retry_wait_ms(4), 480_000);
        assert_eq!(retry_wait_ms(7), RETRY_WAIT_MAX_MS);
        assert_eq!(retry_wait_ms(0), 60_000);
        assert_eq!(retry_wait_ms(i64::MAX), RETRY_WAIT_MAX_MS);
        assert_eq!(retry_allowed(1, None, 0), Ok(()));
        assert_eq!(retry_allowed(1, Some(1_000), 999), Err(RetryHeld::TooSoon));
        assert_eq!(retry_allowed(1, Some(1_000), 1_000), Ok(()));
        assert_eq!(
            retry_allowed(MAX_SETUP_RUNS - 1, Some(1_000), 2_000),
            Ok(())
        );
        // At the limit no wait helps, and the limit is what's said.
        assert_eq!(
            retry_allowed(MAX_SETUP_RUNS, None, i64::MAX),
            Err(RetryHeld::LimitReached)
        );
        assert_eq!(
            retry_allowed(MAX_SETUP_RUNS, Some(1_000), 0),
            Err(RetryHeld::LimitReached)
        );
        assert_eq!(
            retry_allowed(MAX_SETUP_RUNS + 3, Some(1_000), 2_000),
            Err(RetryHeld::LimitReached)
        );
        assert_ne!(RetryHeld::LimitReached.code(), RetryHeld::TooSoon.code());
    }

    #[test]
    fn a_job_that_cant_finish_is_left_alone_for_longer_each_time() {
        assert_eq!(job_backoff_ms(0), 5_000);
        assert_eq!(job_backoff_ms(1), 5_000);
        assert_eq!(job_backoff_ms(2), 10_000);
        assert_eq!(job_backoff_ms(6), 160_000);
        assert_eq!(job_backoff_ms(7), JOB_BACKOFF_MAX_MS);
        assert_eq!(job_backoff_ms(u32::MAX), JOB_BACKOFF_MAX_MS);
    }

    #[test]
    fn a_creation_answer_is_read_from_its_status_and_nothing_else() {
        assert_eq!(
            classify_creation(Some(201), false, true, false),
            Creation::Created
        );
        // Made, by the status, but with no ID to know it by: nobody knows which repository that is.
        assert_eq!(
            classify_creation(Some(201), false, false, false),
            Creation::Unknown
        );
        assert_eq!(
            classify_creation(Some(422), true, false, false),
            Creation::NameTaken
        );
        assert_eq!(
            classify_creation(Some(422), false, false, false),
            Creation::Refused
        );
        for refused in [400, 401, 403, 404, 409, 429] {
            assert_eq!(
                classify_creation(Some(refused), false, false, false),
                Creation::Refused,
                "{refused}"
            );
        }
        // No answer, a server's error, a redirect, or a success that isn't "created": a repository may exist.
        for unknown in [
            None,
            Some(500),
            Some(502),
            Some(503),
            Some(504),
            Some(200),
            Some(202),
            Some(302),
        ] {
            assert_eq!(
                classify_creation(unknown, false, true, false),
                Creation::Unknown,
                "{unknown:?}"
            );
        }
    }

    #[test]
    fn a_retry_name_is_the_chosen_name_and_a_server_suffix_within_the_limit() {
        assert_eq!(
            retry_name("engineering", "7f3a9c").as_deref(),
            Some("engineering-7f3a9c")
        );
        let long = "a".repeat(64);
        let name = retry_name(&long, "000000").unwrap_or_default();
        assert_eq!(name.len(), 64);
        assert!(name.ends_with("-000000") && crate::repositories::valid_repo_name(&name));
        // A stem that would end in a hyphen doesn't double it.
        assert_eq!(
            retry_name(&format!("{}-b", "a".repeat(56)), "abcdef").as_deref(),
            Some(format!("{}-abcdef", "a".repeat(56)).as_str())
        );
        for bad in ["", "7f3a9", "7f3a9c0", "7F3A9C", "zzzzzz", "7f3a9-"] {
            assert_eq!(retry_name("engineering", bad), None, "{bad}");
        }
        assert_eq!(retry_name("", "7f3a9c"), None);
        assert_eq!(retry_name(".github", "7f3a9c"), None);
    }

    #[test]
    fn a_repository_as_setup_leaves_it_is_ready() {
        assert_eq!(verify_ready(&EXPECTED, &ready()), Ok(()));
        assert_eq!(missing_steps(&EXPECTED, &ready()), Ok(vec![]));
        // The order the provider lists rulesets or rules in doesn't matter.
        let mut swapped = ready();
        swapped.rulesets.reverse();
        swapped.rulesets[1].rule_types.reverse();
        assert_eq!(verify_ready(&EXPECTED, &swapped), Ok(()));
    }

    #[test]
    fn a_new_repository_needs_all_three_steps_and_a_half_set_up_one_only_what_is_missing() {
        let fresh = Observed {
            actions_enabled: Some(true),
            rulesets: vec![],
            ..ready()
        };
        assert_eq!(
            missing_steps(&EXPECTED, &fresh),
            Ok(vec![
                SetupStep::DisableActions,
                SetupStep::CreateReviewRuleset,
                SetupStep::CreateUpdateRuleset
            ])
        );
        assert_eq!(
            verify_ready(&EXPECTED, &fresh),
            Err(NotReady::ActionsEnabled)
        );
        let half = Observed {
            rulesets: vec![review()],
            ..ready()
        };
        assert_eq!(
            missing_steps(&EXPECTED, &half),
            Ok(vec![SetupStep::CreateUpdateRuleset])
        );
        assert_eq!(
            verify_ready(&EXPECTED, &half),
            Err(NotReady::RulesetMissing)
        );
        let other_half = Observed {
            rulesets: vec![update()],
            ..ready()
        };
        assert_eq!(
            missing_steps(&EXPECTED, &other_half),
            Ok(vec![SetupStep::CreateReviewRuleset])
        );
        assert_eq!(
            verify_ready(
                &EXPECTED,
                &Observed {
                    actions_enabled: Some(true),
                    ..ready()
                }
            ),
            Err(NotReady::ActionsEnabled)
        );
    }

    #[test]
    fn the_repository_itself_has_to_be_the_one_podster_made_in_its_organization() {
        let wrong = |change: fn(&mut Observed)| {
            let mut observed = ready();
            change(&mut observed);
            (
                missing_steps(&EXPECTED, &observed).err(),
                verify_ready(&EXPECTED, &observed).err(),
            )
        };
        assert_eq!(
            wrong(|o| o.repo_id = 9002),
            (
                Some(NotReady::WrongRepository),
                Some(NotReady::WrongRepository)
            )
        );
        assert_eq!(wrong(|o| o.owner_id = 1).0, Some(NotReady::WrongOwner));
        assert_eq!(
            wrong(|o| o.private = true).0,
            Some(NotReady::VisibilityDiffers)
        );
        assert_eq!(wrong(|o| o.archived = true).0, Some(NotReady::Archived));
        assert_eq!(
            wrong(|o| o.default_branch_has_commit = false).0,
            Some(NotReady::NoInitialCommit)
        );
        assert_eq!(
            wrong(|o| o.actions_enabled = None).0,
            Some(NotReady::ActionsUnreadable)
        );
        // A private repository was asked for and a public one came back.
        let private = Expected {
            public: false,
            ..EXPECTED
        };
        assert_eq!(
            verify_ready(&private, &ready()),
            Err(NotReady::VisibilityDiffers)
        );
        assert_eq!(
            verify_ready(
                &private,
                &Observed {
                    private: true,
                    ..ready()
                }
            ),
            Ok(())
        );
    }

    #[test]
    fn a_rule_that_is_present_and_wrong_is_refused_and_never_repaired() {
        let cases: Vec<(fn(&mut Observed), NotReady)> = vec![
            (
                |o| o.rulesets[0].enforcement = "disabled".to_string(),
                NotReady::RulesetInactive,
            ),
            (
                |o| o.rulesets[1].enforcement = "evaluate".to_string(),
                NotReady::RulesetInactive,
            ),
            (
                |o| o.rulesets[0].target = "tag".to_string(),
                NotReady::RulesetDiffers,
            ),
            (
                |o| o.rulesets[1].include = vec!["refs/heads/other".to_string()],
                NotReady::RulesetDiffers,
            ),
            (
                |o| o.rulesets[1].include.push("refs/heads/other".to_string()),
                NotReady::RulesetDiffers,
            ),
            (|o| o.rulesets[1].include.clear(), NotReady::RulesetDiffers),
            (
                |o| o.rulesets[1].exclude = vec!["refs/heads/main".to_string()],
                NotReady::RulesetDiffers,
            ),
            // The required status: another App's, anyone's, another context, a second one, none.
            (
                |o| o.rulesets[0].required_statuses[0].1 = Some(8),
                NotReady::RulesetDiffers,
            ),
            (
                |o| o.rulesets[0].required_statuses[0].1 = None,
                NotReady::RulesetDiffers,
            ),
            (
                |o| o.rulesets[0].required_statuses[0].0 = "other".to_string(),
                NotReady::RulesetDiffers,
            ),
            (
                |o| {
                    o.rulesets[0]
                        .required_statuses
                        .push(("ci".to_string(), None))
                },
                NotReady::RulesetDiffers,
            ),
            (
                |o| o.rulesets[0].required_statuses.clear(),
                NotReady::RulesetDiffers,
            ),
            // The bypass lists: anyone on the review ruleset; an extra, another, a weaker mode or nobody on the update one; unseen.
            (
                |o| o.rulesets[0].bypass = Some(vec![merge_app()]),
                NotReady::BypassDiffers,
            ),
            (
                |o| {
                    o.rulesets[1]
                        .bypass
                        .as_mut()
                        .unwrap_or(&mut vec![])
                        .push(Bypass {
                            actor_id: Some(1),
                            actor_type: "OrganizationAdmin".to_string(),
                            mode: "always".to_string(),
                        })
                },
                NotReady::BypassDiffers,
            ),
            (
                |o| o.rulesets[1].bypass = Some(vec![]),
                NotReady::BypassDiffers,
            ),
            (
                |o| {
                    o.rulesets[1].bypass = Some(vec![Bypass {
                        actor_id: Some(8),
                        ..merge_app()
                    }])
                },
                NotReady::BypassDiffers,
            ),
            (
                |o| {
                    o.rulesets[1].bypass = Some(vec![Bypass {
                        actor_id: None,
                        ..merge_app()
                    }])
                },
                NotReady::BypassDiffers,
            ),
            (
                |o| {
                    o.rulesets[1].bypass = Some(vec![Bypass {
                        actor_type: "Team".to_string(),
                        ..merge_app()
                    }])
                },
                NotReady::BypassDiffers,
            ),
            (
                |o| {
                    o.rulesets[1].bypass = Some(vec![Bypass {
                        mode: "pull_request".to_string(),
                        ..merge_app()
                    }])
                },
                NotReady::BypassDiffers,
            ),
            (|o| o.rulesets[0].bypass = None, NotReady::BypassDiffers),
            (|o| o.rulesets[1].bypass = None, NotReady::BypassDiffers),
            // A ruleset Podster didn't make: another shape, or a second of a kind.
            (
                |o| o.rulesets.push(ruleset(&["deletion"])),
                NotReady::UnexpectedRuleset,
            ),
            (
                |o| o.rulesets[1].rule_types.push("deletion".to_string()),
                NotReady::UnexpectedRuleset,
            ),
            (
                |o| o.rulesets[0].rule_types = vec!["pull_request".to_string()],
                NotReady::UnexpectedRuleset,
            ),
            (|o| o.rulesets.push(update()), NotReady::UnexpectedRuleset),
            (|o| o.rulesets.push(review()), NotReady::UnexpectedRuleset),
            (
                |o| o.rulesets[0].rule_types.clear(),
                NotReady::UnexpectedRuleset,
            ),
        ];
        for (i, (change, reason)) in cases.into_iter().enumerate() {
            let mut observed = ready();
            change(&mut observed);
            // Neither accepted as ready, nor offered a step that would cover it up.
            assert_eq!(missing_steps(&EXPECTED, &observed), Err(reason), "case {i}");
            assert_eq!(verify_ready(&EXPECTED, &observed), Err(reason), "case {i}");
        }
    }

    #[test]
    fn every_reason_has_its_own_code() {
        let all = [
            NotReady::WrongRepository,
            NotReady::WrongOwner,
            NotReady::VisibilityDiffers,
            NotReady::Archived,
            NotReady::NoInitialCommit,
            NotReady::ActionsEnabled,
            NotReady::ActionsUnreadable,
            NotReady::RulesetMissing,
            NotReady::RulesetInactive,
            NotReady::RulesetDiffers,
            NotReady::BypassDiffers,
            NotReady::UnexpectedRuleset,
        ];
        let mut codes: Vec<&str> = all.iter().map(|r| r.code()).collect();
        codes.sort_unstable();
        codes.dedup();
        assert_eq!(codes.len(), all.len());
    }

    #[test]
    fn a_ready_link_is_read_back_a_day_after_it_was_last_found_right_and_retried_hourly() {
        assert_eq!(
            readiness_due_at(1_000, None, None),
            1_000 + READINESS_INTERVAL_MS
        );
        // An attempt long ago doesn't bring it forward.
        assert_eq!(
            readiness_due_at(1_000, Some(500), None),
            1_000 + READINESS_INTERVAL_MS
        );
        // A day on, an attempt that found nothing definite: the next waits an hour, not a day.
        let attempt = 1_000 + READINESS_INTERVAL_MS;
        assert_eq!(
            readiness_due_at(1_000, Some(attempt), None),
            attempt + READINESS_RETRY_MS
        );
        assert_eq!(readiness_due_at(i64::MAX, None, None), i64::MAX);
        // Seen gone: looked at again a minute later, and a minute after a look that couldn't be made.
        assert_eq!(
            readiness_due_at(1_000, None, Some(5_000)),
            5_000 + GONE_CONFIRM_MS
        );
        assert_eq!(
            readiness_due_at(1_000, Some(70_000), Some(5_000)),
            70_000 + GONE_CONFIRM_MS
        );
    }

    #[test]
    fn only_a_404_to_a_token_just_minted_says_the_repository_is_gone() {
        assert!(repository_gone(true, 404));
        // No token: the key, the installation or a limit, never the repository.
        assert!(!repository_gone(false, 404));
        for status in [200, 301, 401, 403, 422, 429, 500, 502, 503] {
            assert!(!repository_gone(true, status), "{status}");
        }
        assert_eq!(
            missing_steps(&EXPECTED, &gone(9001)),
            Err(NotReady::RepositoryGone)
        );
        assert_eq!(
            verify_ready(&EXPECTED, &gone(9001)),
            Err(NotReady::RepositoryGone)
        );
        assert_eq!(NotReady::RepositoryGone.code(), "repository_gone");
        // The presence check's token: metadata to read, and nothing more.
        let hour = 1_000 + 60 * 60 * 1000;
        assert!(token_answer_matches(
            None,
            &[],
            &PRESENCE_PERMISSIONS,
            &PRESENCE_PERMISSIONS,
            Some(hour),
            1_000
        ));
        assert!(!token_answer_matches(
            None,
            &[],
            &PROVISIONING_PERMISSIONS,
            &PRESENCE_PERMISSIONS,
            Some(hour),
            1_000
        ));
    }

    #[test]
    fn a_rate_limited_request_waits_for_a_day_from_its_first_limit_however_many_come() {
        assert!(rate_limited_run_waits(None, 5_000));
        assert!(rate_limited_run_waits(
            Some(5_000),
            5_000 + RATE_LIMITED_FOR_MS - 1
        ));
        assert!(!rate_limited_run_waits(
            Some(5_000),
            5_000 + RATE_LIMITED_FOR_MS
        ));
        assert!(!rate_limited_run_waits(Some(i64::MIN), i64::MAX));
    }

    #[test]
    fn a_repository_is_gone_only_on_a_second_look_a_minute_after_the_first() {
        assert_eq!(gone_look(None, 1_000), GoneLook::FirstSeen);
        assert_eq!(
            gone_look(Some(1_000), 1_000 + GONE_CONFIRM_MS - 1),
            GoneLook::TooSoon
        );
        assert_eq!(
            gone_look(Some(1_000), 1_000 + GONE_CONFIRM_MS),
            GoneLook::Confirmed
        );
        assert_eq!(
            gone_look(Some(1_000), 1_000 + GONE_SIGHTING_MAX_AGE_MS),
            GoneLook::Confirmed
        );
        // Older than that, it's a first sighting again.
        assert_eq!(
            gone_look(Some(1_000), 1_000 + GONE_SIGHTING_MAX_AGE_MS + 1),
            GoneLook::FirstSeen
        );
    }

    #[test]
    fn a_rate_limited_creation_is_its_own_outcome_and_made_nothing() {
        for status in [403, 429] {
            assert_eq!(
                classify_creation(Some(status), false, false, true),
                Creation::RateLimited,
                "{status}"
            );
        }
        // Only a 403 or a 429 can be a limit. The others read as they always did.
        assert_eq!(
            classify_creation(Some(201), false, true, true),
            Creation::Created
        );
        assert_eq!(
            classify_creation(Some(500), false, false, true),
            Creation::Unknown
        );
    }

    #[test]
    fn settings_creation_turned_off_must_read_back_off() {
        assert_eq!(verify_ready(&EXPECTED, &ready()), Ok(()));
        let differs: [fn(&mut RepoSettings); 6] = [
            |s| s.has_issues = true,
            |s| s.has_wiki = true,
            |s| s.has_projects = true,
            |s| s.has_discussions = true,
            |s| s.allow_auto_merge = Some(true),
            |s| s.delete_branch_on_merge = Some(true),
        ];
        for change in differs {
            let mut observed = ready();
            change(&mut observed.settings);
            assert_eq!(
                missing_steps(&EXPECTED, &observed),
                Err(NotReady::SettingsDiffer)
            );
            assert_eq!(
                verify_ready(&EXPECTED, &observed),
                Err(NotReady::SettingsDiffer)
            );
        }
        // GitHub shows merge settings only to a token that can write contents. Not shown is no difference.
        let mut unseen = ready();
        unseen.settings.allow_auto_merge = None;
        unseen.settings.delete_branch_on_merge = None;
        assert_eq!(verify_ready(&EXPECTED, &unseen), Ok(()));
        assert_eq!(NotReady::SettingsDiffer.code(), "settings_differ");
    }

    #[test]
    fn workflows_that_can_write_or_approve_are_narrowed_at_setup_and_a_difference_after() {
        for workflow in [
            WorkflowPermissions {
                default: "write".to_string(),
                can_approve_pull_request_reviews: false,
            },
            WorkflowPermissions {
                default: "read".to_string(),
                can_approve_pull_request_reviews: true,
            },
            WorkflowPermissions {
                default: "?".to_string(),
                can_approve_pull_request_reviews: false,
            },
        ] {
            let observed = Observed {
                workflow,
                ..ready()
            };
            assert_eq!(
                missing_steps(&EXPECTED, &observed),
                Ok(vec![SetupStep::RestrictWorkflowPermissions])
            );
            assert_eq!(
                verify_ready(&EXPECTED, &observed),
                Err(NotReady::WorkflowPermissionsDiffer)
            );
        }
        assert_eq!(
            NotReady::WorkflowPermissionsDiffer.code(),
            "workflow_permissions_differ"
        );
    }

    #[test]
    fn a_provisioning_token_is_used_only_if_it_is_exactly_what_was_asked_for() {
        const NOW: i64 = 1_000_000;
        let asked = PROVISIONING_PERMISSIONS;
        let hour = NOW + 60 * 60 * 1000;
        assert!(provisioning_token_matches(
            Some(9001),
            &[9001],
            &asked,
            Some(hour),
            NOW
        ));
        // The creation token reaches the installation's repositories, since its own doesn't exist yet.
        assert!(provisioning_token_matches(
            None,
            &[],
            &asked,
            Some(hour),
            NOW
        ));
        // Another repository, or more than the one.
        assert!(!provisioning_token_matches(
            Some(9001),
            &[9002],
            &asked,
            Some(hour),
            NOW
        ));
        assert!(!provisioning_token_matches(
            Some(9001),
            &[9001, 9002],
            &asked,
            Some(hour),
            NOW
        ));
        assert!(!provisioning_token_matches(
            Some(9001),
            &[],
            &asked,
            Some(hour),
            NOW
        ));
        // Wider, narrower, or different permissions.
        let wider = [asked[0], asked[1], ("contents", "write")];
        assert!(!provisioning_token_matches(
            Some(9001),
            &[9001],
            &wider,
            Some(hour),
            NOW
        ));
        assert!(!provisioning_token_matches(
            Some(9001),
            &[9001],
            &asked[..1],
            Some(hour),
            NOW
        ));
        let read_only = [("administration", "read"), ("metadata", "read")];
        assert!(!provisioning_token_matches(
            Some(9001),
            &[9001],
            &read_only,
            Some(hour),
            NOW
        ));
        // No expiry, one already past, or one further off than GitHub gives.
        assert!(!provisioning_token_matches(
            Some(9001),
            &[9001],
            &asked,
            None,
            NOW
        ));
        assert!(!provisioning_token_matches(
            Some(9001),
            &[9001],
            &asked,
            Some(NOW),
            NOW
        ));
        assert!(!provisioning_token_matches(
            Some(9001),
            &[9001],
            &asked,
            Some(NOW + TOKEN_LIFE_MAX_MS + 1),
            NOW
        ));
    }
}

/// What an operator's recheck of a room's repository read (M5 step 7b).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecheckRead {
    /// Everything read back is exactly what provisioning set, and the default branch is the link's.
    ExactlyRight,
    /// A definite difference, with its reason code.
    Differs(&'static str),
    /// No definite answer.
    CouldNotRead,
}

/// What a recheck does to the link.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Recheck {
    /// Nothing to change: a ready link read back exactly right, or a suspended one, which isn't lifted here.
    Unchanged,
    /// Ready, and read back with a definite difference: degraded now, for this reason, as the scheduled read and a
    /// merge would. An operator's way to make Podster stop after a takedown done by hand on GitHub.
    Degrade(&'static str),
    /// Degraded, and read back exactly right: ready again.
    MakeReady,
    /// Still degraded, for this reason now.
    StillDegraded(&'static str),
    /// Nothing can be said, and nothing changes.
    Unavailable,
}

/// Decides an operator's recheck, from the same read-back the merge job and the scheduled read use. A degraded link
/// becomes ready only on a read-back that is exactly right. A ready link is degraded on a definite difference, and stays
/// as it is when it reads back right. A suspended link isn't lifted here. `read` is `None` when no read was made, which,
/// like a read that couldn't be made, changes nothing and says so.
pub fn decide_recheck(
    status: crate::repositories::LinkStatus,
    read: Option<RecheckRead>,
) -> Recheck {
    use crate::repositories::LinkStatus;
    match (status, read) {
        (LinkStatus::Suspended, _) | (LinkStatus::Ready, Some(RecheckRead::ExactlyRight)) => {
            Recheck::Unchanged
        }
        (LinkStatus::Ready, Some(RecheckRead::Differs(reason))) => Recheck::Degrade(reason),
        (LinkStatus::Ready, Some(RecheckRead::CouldNotRead) | None) => Recheck::Unavailable,
        (LinkStatus::Degraded, Some(RecheckRead::ExactlyRight)) => Recheck::MakeReady,
        (LinkStatus::Degraded, Some(RecheckRead::Differs(reason))) => {
            Recheck::StillDegraded(reason)
        }
        (LinkStatus::Degraded, Some(RecheckRead::CouldNotRead) | None) => Recheck::Unavailable,
    }
}

/// How many requests for a repository are accepted in [`REPOSITORY_REQUEST_WINDOW_MS`], for one organization and,
/// separately, for one person who asks (both proposed). Every organization may have managed repositories unless an
/// operator took that back (the owner's decision of 2026-11-11, "No gate, with limits"), so these hold abuse instead of
/// an approval. A room has at most one request in its whole life, so a retry of a failed setup and a replayed request
/// are the same room's request and count once.
pub const MAX_REPOSITORY_REQUESTS_PER_DAY: i64 = 5;
/// The rolling window the cap counts over: 24 hours.
pub const REPOSITORY_REQUEST_WINDOW_MS: i64 = 24 * 60 * 60 * 1000;

/// `repository_request_limit`: the organization, or the person asking, has had its requests for the day accepted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RequestLimitReached;

impl RequestLimitReached {
    // codes: errors
    pub fn code(self) -> &'static str {
        "repository_request_limit"
    }
}

/// Whether one more request for a repository is accepted. `accepted_at` are the times of the requests already
/// accepted for other rooms, for the organization or for the person, whichever is being counted; one from this room is
/// never among them, so asking again for the same room is always allowed here. Only those inside the window count.
pub fn repository_request_allowed(
    accepted_at: &[i64],
    now: i64,
) -> Result<(), RequestLimitReached> {
    let recent = accepted_at
        .iter()
        .filter(|at| now.saturating_sub(**at) < REPOSITORY_REQUEST_WINDOW_MS)
        .count();
    if recent as i64 >= MAX_REPOSITORY_REQUESTS_PER_DAY {
        Err(RequestLimitReached)
    } else {
        Ok(())
    }
}

/// Whether a room holds a place in one count, an organization's or a person's, after asking now. `holds` says the room
/// already has a place there that hasn't left the window: it keeps it, whatever the count, since it adds no room.
/// Otherwise it takes one only if [`repository_request_allowed`] allows, on the stamps of the other rooms' places. A
/// place is never given back, so this only ever errs towards refusing.
pub fn repository_place_held(holds: bool, others_stamped_at: &[i64], now: i64) -> bool {
    holds || repository_request_allowed(others_stamped_at, now).is_ok()
}

/// Whether an organization holds the provisioning delegation, from what its record says: held unless an operator
/// explicitly took it back. No record means held.
pub fn organization_delegated(recorded: Option<bool>) -> bool {
    recorded != Some(false)
}

/// The literal entry in a deployment's list of repository requesters that stands for every test person.
pub const TEST_PEOPLE_ENTRY: &str = "test-people";

/// The literal entry that stands for the deployment's operators: the people its own configuration names as Podster
/// operators. A deployment gets them only by writing this entry. They're never implied.
pub const OPERATORS_ENTRY: &str = "operators";

/// What every test person's ID starts with: `per_` and the `e2e_` the gateway's secret-protected test sign-up gives
/// its users' IDs, which no other sign-up produces. The ID is the verified caller's, from the gateway's assertion,
/// never anything a client sends.
pub const TEST_PERSON_PREFIX: &str = "per_e2e_";

/// The longest person ID a list entry may be. Longer is malformed.
const MAX_REQUESTER_ID: usize = 128;

/// Whether an ID is a test person's: made by the test sign-up.
pub fn is_test_person(person_id: &str) -> bool {
    person_id.len() > TEST_PERSON_PREFIX.len() && person_id.starts_with(TEST_PERSON_PREFIX)
}

/// Whether a list entry is shaped like a person's ID: `per_`, then letters, digits, `_` or `-`.
fn person_id_entry(entry: &str) -> bool {
    entry.len() <= MAX_REQUESTER_ID
        && entry.strip_prefix("per_").is_some_and(|rest| {
            !rest.is_empty()
                && rest
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        })
}

/// Who a deployment lets ask for a room's repository, or retry its setup: a deployment's setting, beside the rule
/// that it's a person who is the room's owner or a room admin (added by the architect on 2026-11-11, after M5's
/// security review). It narrows who may ask and never widens it. Nothing else reads it: grants, tokens, merges and
/// reads of a repository a room already has don't.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RepositoryRequesters {
    /// The setting is absent: the feature's ordinary rules apply to everyone.
    Everyone,
    /// The setting is present: only these may ask. Empty with no test people is nobody.
    Only {
        /// Person IDs, exactly as listed.
        people: Vec<String>,
        /// Whether the list holds [`TEST_PEOPLE_ENTRY`]: every test person may ask.
        test_people: bool,
        /// Whether the list holds [`OPERATORS_ENTRY`]: every operator the deployment names may ask.
        operators: bool,
    },
}

/// What a deployment's configuration holds under a setting's name, as the Worker found it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Configured<'a> {
    /// Nothing is bound under the name.
    Absent,
    /// A string is bound under it.
    Text(&'a str),
    /// Something is bound under it that isn't a string, or it couldn't be read: a list, a number, an object, a
    /// binding of another kind, an error.
    Unreadable,
}

impl RepositoryRequesters {
    /// Reads the setting from what the Worker found under its name. Only a name with nothing bound is "unset", which
    /// is everyone. A string is read by [`RepositoryRequesters::parse`]. Anything else is nobody: a setting that is
    /// there and can't be read as text was meant to narrow who may ask, so it never widens it.
    pub fn read(configured: Configured) -> Self {
        match configured {
            Configured::Absent => RepositoryRequesters::Everyone,
            Configured::Text(value) => Self::parse(Some(value)),
            Configured::Unreadable => Self::nobody(),
        }
    }

    /// Nobody may ask.
    pub fn nobody() -> Self {
        RepositoryRequesters::Only {
            people: Vec::new(),
            test_people: false,
            operators: false,
        }
    }

    /// Reads the setting. Absent is everyone. Present, it's entries separated by commas, each a person's ID,
    /// [`TEST_PEOPLE_ENTRY`] or [`OPERATORS_ENTRY`], with spaces around an entry ignored. Anything else is nobody, the
    /// whole list with it: an empty value, an empty entry, an entry of any other shape or an unknown word. So a slip
    /// in the setting closes requests and never opens them. An operator isn't implied, and neither is anyone else.
    pub fn parse(configured: Option<&str>) -> Self {
        let Some(configured) = configured else {
            return RepositoryRequesters::Everyone;
        };
        let mut people = Vec::new();
        let mut test_people = false;
        let mut operators = false;
        for entry in configured.split(',').map(|entry| entry.trim_matches(' ')) {
            if entry == TEST_PEOPLE_ENTRY {
                test_people = true;
            } else if entry == OPERATORS_ENTRY {
                operators = true;
            } else if person_id_entry(entry) {
                people.push(entry.to_string());
            } else {
                return Self::nobody();
            }
        }
        RepositoryRequesters::Only {
            people,
            test_people,
            operators,
        }
    }

    /// Whether this person may ask, as far as the deployment's setting goes. `person_id` is the verified caller's,
    /// and a person's: the caller's kind is the policy's to check first. `deployment_operators` is the people the
    /// deployment's own configuration names as operators, read by the Worker and never from a caller. It counts
    /// only if the list holds [`OPERATORS_ENTRY`], and an empty one names nobody.
    pub fn allows(&self, person_id: &str, deployment_operators: &[&str]) -> bool {
        match self {
            RepositoryRequesters::Everyone => true,
            RepositoryRequesters::Only {
                people,
                test_people,
                operators,
            } => {
                !person_id.is_empty()
                    && ((*test_people && is_test_person(person_id))
                        || (*operators && deployment_operators.contains(&person_id))
                        || people.iter().any(|listed| listed == person_id))
            }
        }
    }
}

#[cfg(test)]
mod recheck_tests {
    use super::*;
    use crate::repositories::LinkStatus;

    #[test]
    fn only_a_degraded_link_read_back_exactly_right_becomes_ready() {
        assert_eq!(
            decide_recheck(LinkStatus::Degraded, Some(RecheckRead::ExactlyRight)),
            Recheck::MakeReady
        );
        assert_eq!(
            decide_recheck(
                LinkStatus::Degraded,
                Some(RecheckRead::Differs("bypass_differs"))
            ),
            Recheck::StillDegraded("bypass_differs")
        );
        for unread in [Some(RecheckRead::CouldNotRead), None] {
            assert_eq!(
                decide_recheck(LinkStatus::Degraded, unread),
                Recheck::Unavailable
            );
        }
        // A ready link: degraded on a definite difference, left as it is when it reads right, and unread is unavailable.
        assert_eq!(
            decide_recheck(
                LinkStatus::Ready,
                Some(RecheckRead::Differs("repository_gone"))
            ),
            Recheck::Degrade("repository_gone")
        );
        assert_eq!(
            decide_recheck(LinkStatus::Ready, Some(RecheckRead::ExactlyRight)),
            Recheck::Unchanged
        );
        for unread in [Some(RecheckRead::CouldNotRead), None] {
            assert_eq!(
                decide_recheck(LinkStatus::Ready, unread),
                Recheck::Unavailable
            );
        }
        for status in [LinkStatus::Suspended] {
            for read in [
                Some(RecheckRead::ExactlyRight),
                Some(RecheckRead::Differs("x")),
                Some(RecheckRead::CouldNotRead),
                None,
            ] {
                assert_eq!(
                    decide_recheck(status, read),
                    Recheck::Unchanged,
                    "{status:?}"
                );
            }
        }
    }
}
