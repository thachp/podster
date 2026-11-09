//! Reports and Podster operators (M4 step 10, decisions 158 and 160). No I/O.
//!
//! - **Reports** come from signed-in people only, about a public room or an agent seen in one, with a reason code and a
//!   note of at most 1 KB, 10 a day per person.
//! - **Operators** are person IDs in the API's configuration. Only a caller of kind person whose ID is listed is one. They
//!   see only the public view and reports, and can suspend or lift a room's public surface and an agent's public claims.
//!   They can't read private rooms, end claims or change access.

/// Reports one person may make in a day.
pub const MAX_REPORTS_PER_DAY: u32 = 10;
/// The longest report note, in bytes.
pub const MAX_REPORT_NOTE_BYTES: usize = 1024;
/// The window the daily report limit counts over, in milliseconds.
pub const REPORT_WINDOW_MS: i64 = 24 * 60 * 60 * 1000;

/// Why something was reported, or why an operator acted. One list for both, so an action can name the report's reason.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason {
    Spam,
    Abuse,
    Illegal,
    Impersonation,
    Privacy,
    Other,
}

impl Reason {
    pub const ALL: [Reason; 6] = [
        Reason::Spam,
        Reason::Abuse,
        Reason::Illegal,
        Reason::Impersonation,
        Reason::Privacy,
        Reason::Other,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Reason::Spam => "spam",
            Reason::Abuse => "abuse",
            Reason::Illegal => "illegal",
            Reason::Impersonation => "impersonation",
            Reason::Privacy => "privacy",
            Reason::Other => "other",
        }
    }

    pub fn from_name(name: &str) -> Option<Reason> {
        Reason::ALL.into_iter().find(|r| r.name() == name)
    }
}

/// Whether a caller is a Podster operator: a person whose ID is in the configured list. An agent never is, even with a
/// listed ID, and an empty list names nobody.
pub fn is_operator(caller_kind: &str, caller_id: &str, operators: &[&str]) -> bool {
    caller_kind == "person" && !caller_id.is_empty() && operators.contains(&caller_id)
}

/// Parses the configured list: person IDs separated by commas, with blanks ignored.
pub fn parse_operators(configured: &str) -> Vec<&str> {
    configured
        .split(',')
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .collect()
}

/// Why a report was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReportRefusal {
    NotAPerson,
    BadReason,
    NoteTooLong,
    DailyLimit,
}

impl ReportRefusal {
    pub fn code(self) -> &'static str {
        match self {
            ReportRefusal::NotAPerson => "not_allowed",
            ReportRefusal::BadReason | ReportRefusal::NoteTooLong => "invalid_argument",
            ReportRefusal::DailyLimit => "limit_exceeded",
        }
    }
}

/// A report's checks, before it's kept: a person, a known reason, a short enough note, and under the daily limit counting
/// the reports they made in the last day.
pub fn check_report(
    caller_kind: &str,
    reason: &str,
    note: Option<&str>,
    made_in_last_day: u32,
) -> Result<Reason, ReportRefusal> {
    if caller_kind != "person" {
        return Err(ReportRefusal::NotAPerson);
    }
    let reason = Reason::from_name(reason).ok_or(ReportRefusal::BadReason)?;
    if note.is_some_and(|n| n.len() > MAX_REPORT_NOTE_BYTES) {
        return Err(ReportRefusal::NoteTooLong);
    }
    if made_in_last_day >= MAX_REPORTS_PER_DAY {
        return Err(ReportRefusal::DailyLimit);
    }
    Ok(reason)
}
