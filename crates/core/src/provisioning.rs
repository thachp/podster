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
    /// Nobody knows: no answer, a server error, or an answer that can't be read. A repository may exist.
    Unknown,
}

/// Reads a creation call's outcome from its HTTP status, if one came back. `name_error` says the provider's answer blamed
/// the name, and `has_id` that a created answer carried a repository ID.
pub fn classify_creation(status: Option<u16>, name_error: bool, has_id: bool) -> Creation {
    match status {
        Some(201) if has_id => Creation::Created,
        Some(422) if name_error => Creation::NameTaken,
        // A client error says the call was understood and refused, so nothing was made.
        Some(400..=499) => Creation::Refused,
        _ => Creation::Unknown,
    }
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

/// Everything read back about a repository.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Observed {
    pub repo_id: i64,
    pub owner_id: i64,
    pub private: bool,
    pub archived: bool,
    pub default_branch_has_commit: bool,
    /// `None` if the setting couldn't be read.
    pub actions_enabled: Option<bool>,
    pub rulesets: Vec<Ruleset>,
}

/// Why a repository isn't ready. Each is a reason code the room's people see.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotReady {
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
}

impl NotReady {
    pub fn code(self) -> &'static str {
        match self {
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
        }
    }
}

/// Something setup may add to a repository Podster made. Setup only ever adds what's missing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SetupStep {
    DisableActions,
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

/// What setup still has to add, or why this repository can't be made ready. Anything present and wrong is a refusal:
/// setup never edits or removes a rule, so a rule someone changed is seen and not papered over.
pub fn missing_steps(expected: &Expected, observed: &Observed) -> Result<Vec<SetupStep>, NotReady> {
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
    let mut steps = vec![];
    match observed.actions_enabled {
        None => return Err(NotReady::ActionsUnreadable),
        Some(true) => steps.push(SetupStep::DisableActions),
        Some(false) => {}
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
            repo_id: 9001,
            owner_id: 4242,
            private: false,
            archived: false,
            default_branch_has_commit: true,
            actions_enabled: Some(false),
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
        assert_eq!(classify_creation(Some(201), false, true), Creation::Created);
        // Made, by the status, but with no ID to know it by: nobody knows which repository that is.
        assert_eq!(
            classify_creation(Some(201), false, false),
            Creation::Unknown
        );
        assert_eq!(
            classify_creation(Some(422), true, false),
            Creation::NameTaken
        );
        assert_eq!(
            classify_creation(Some(422), false, false),
            Creation::Refused
        );
        for refused in [400, 401, 403, 404, 409, 429] {
            assert_eq!(
                classify_creation(Some(refused), false, false),
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
                classify_creation(unknown, false, true),
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
    /// The link isn't degraded, so there's nothing to recheck. It stays as it is.
    Unchanged,
    /// Degraded, and read back exactly right: ready again.
    MakeReady,
    /// Still degraded, for this reason now.
    StillDegraded(&'static str),
    /// Nothing can be said, and nothing changes.
    Unavailable,
}

/// Decides an operator's recheck. Only a degraded link is ever changed, only to ready, and only on a read-back that is
/// exactly right. A suspended link isn't lifted here, and nothing here degrades. `read` is `None` when no read was made.
pub fn decide_recheck(
    status: crate::repositories::LinkStatus,
    read: Option<RecheckRead>,
) -> Recheck {
    use crate::repositories::LinkStatus;
    match (status, read) {
        (LinkStatus::Ready | LinkStatus::Suspended, _) => Recheck::Unchanged,
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

/// Whether an organization holds the provisioning delegation, from what its record says: held unless an operator
/// explicitly took it back. No record means held.
pub fn organization_delegated(recorded: Option<bool>) -> bool {
    recorded != Some(false)
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
        for status in [LinkStatus::Ready, LinkStatus::Suspended] {
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
