//! The first Gantt's forecast: a read-only baseline over a whole room's plan. Rules: "Gantt and bounded forecast" in
//! [task planning](../../../docs/spec/TASK-PLANNING.md), decisions 67 to 73.
//!
//! The same inputs always give the same answer, whatever order they come in. It reads no clock, so it doesn't move with today's
//! date. Among the tasks in the scenario, status changes no date: a finished task sits where its estimate puts it, not where it
//! really ran. Status does decide which tasks are in the scenario, so canceling, completing or creating a task can change the
//! answer with no plan edit. That's why the API doesn't offer the plan's revision as a version of the forecast.
//!
//! What's in the scenario:
//!
//! - Every unfinished task, which has to have an estimate.
//! - Every completed task with an estimate.
//! - No canceled task. Canceling one with no successors in the scenario can shorten the plan. If a task in the scenario still has
//!   one as a predecessor, the forecast is withheld until someone removes that edge.
//! - No completed task without an estimate, because a finished task's plan can't be edited and one from before estimates would
//!   otherwise withhold the room's forecast for good. These are listed in `left_out`. An unfinished task that follows one is
//!   withheld as missing an estimate, since its start depends on an unknown, and removing the edge fixes that. A completed task
//!   that follows one can't be fixed by anyone, so that edge alone is ignored.
//!
//! Durations are whole working days on a fixed Mon to Fri calendar that ignores holidays, so one counts as a working day. Task `i` starting on index `s` for `d` days
//! covers indexes `s..s + d`, and a successor starts on the next index, so spans are inclusive of their last day.
use crate::{TaskStatus, MAX_TASK_DURATION_DAYS};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fmt;

pub const BASELINE_LABEL: &str = "Baseline plan";
/// Said with every forecast, so nobody takes one for more than it is (decisions 69, 70 and 72).
pub const BASELINE_ASSUMPTIONS: [&str; 4] = [
    "Estimates include acceptance and review time.",
    "Working days are Monday to Friday. Holidays aren't taken into account.",
    "No capacity/resource leveling.",
    "Dates reflect each task's status and which tasks exist when this is read. The last-changed time covers only estimates, dependencies and the start date, so this can change without it.",
];
/// How many tied critical paths a forecast lists, since ties multiply. Each task still says whether it's critical.
pub const MAX_CRITICAL_PATHS: usize = 20;
/// How many task IDs those paths hold between them, since one path can run through every task in a room.
pub const MAX_CRITICAL_PATH_IDS: usize = 10_000;
const EARLIEST_START: &str = "2000-01-01";
const LATEST_START: &str = "2100-12-31";
const MAX_TIMEZONE_BYTES: usize = 64;

/// A local calendar date, with no time and no timezone. A room's start date is one of these, so it can't shift across midnight.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct CalendarDate {
    /// Days since 1970-01-01, which was a Thursday.
    days: i64,
}

impl CalendarDate {
    /// Exactly `YYYY-MM-DD`, for a date that exists.
    pub fn parse(text: &str) -> Option<CalendarDate> {
        let number = |part: &str, width: usize| -> Option<i64> {
            (part.len() == width && part.bytes().all(|b| b.is_ascii_digit()))
                .then(|| part.parse().ok())
                .flatten()
        };
        let mut parts = text.split('-');
        let year = number(parts.next()?, 4)?;
        let month = number(parts.next()?, 2)?;
        let day = number(parts.next()?, 2)?;
        if parts.next().is_some() {
            return None;
        }
        if !(1..=12).contains(&month) || day < 1 || day > days_in_month(year, month) {
            return None;
        }
        Some(CalendarDate {
            days: days_from_civil(year, month, day),
        })
    }

    /// Monday is 0.
    fn weekday(self) -> i64 {
        (self.days + 3).rem_euclid(7)
    }

    /// The working day `index` working days after the first one on or after this date. A start on a weekend begins on Monday.
    pub fn working_day(self, index: i64) -> CalendarDate {
        let first = match self.weekday() {
            5 => self.days + 2,
            6 => self.days + 1,
            _ => self.days,
        };
        let weekday = (first + 3).rem_euclid(7);
        let (weeks, rest) = (index / 5, index % 5);
        let weekend = if weekday + rest >= 5 { 2 } else { 0 };
        CalendarDate {
            days: first + weeks * 7 + rest + weekend,
        }
    }
}

impl fmt::Display for CalendarDate {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let (year, month, day) = civil_from_days(self.days);
        write!(f, "{year:04}-{month:02}-{day:02}")
    }
}

fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        2 if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// Howard Hinnant's `days_from_civil`, for the proleptic Gregorian calendar.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let of_era = year - era * 400;
    let shifted_month = (month + 9) % 12;
    let of_year = (153 * shifted_month + 2) / 5 + day - 1;
    let of_era_days = of_era * 365 + of_era / 4 - of_era / 100 + of_year;
    era * 146_097 + of_era_days - 719_468
}

/// The inverse of `days_from_civil`.
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let of_era = shifted - era * 146_097;
    let year_of_era = (of_era - of_era / 1_460 + of_era / 36_524 - of_era / 146_096) / 365;
    let of_year = of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * of_year + 2) / 153;
    let day = of_year - (153 * shifted_month + 2) / 5 + 1;
    let month = if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// A room's start date, within bounds that keep every forecast's dates to four-digit years, and the shape of a timezone name. Whether
/// that name is a real timezone needs a timezone database, so the API asks its runtime, after this. An offset such as `+01:00`
/// isn't a name, so it's refused here.
pub fn validate_plan_start(date: &str, timezone: &str) -> Result<CalendarDate, crate::CoreError> {
    let parsed =
        CalendarDate::parse(date).ok_or(crate::CoreError::InvalidArgument("start_date"))?;
    let earliest = CalendarDate::parse(EARLIEST_START);
    let latest = CalendarDate::parse(LATEST_START);
    if earliest.is_some_and(|d| parsed < d) || latest.is_some_and(|d| parsed > d) {
        return Err(crate::CoreError::InvalidArgument("start_date"));
    }
    let named = timezone.len() <= MAX_TIMEZONE_BYTES
        && timezone.split('/').all(|part| {
            part.starts_with(|c: char| c.is_ascii_alphabetic())
                && part
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '+'))
        });
    if !named {
        return Err(crate::CoreError::InvalidArgument("timezone"));
    }
    Ok(parsed)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BaselineTask {
    pub id: String,
    pub status: TaskStatus,
    pub duration_days: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BaselineInput {
    pub start: Option<CalendarDate>,
    pub tasks: Vec<BaselineTask>,
    /// `(predecessor, successor)`.
    pub edges: Vec<(String, String)>,
}

/// Why there's no forecast. These are for someone who sees the whole room, and say nothing about which task.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Withheld {
    NoStart,
    NoTasks,
    MissingEstimates,
    CanceledPredecessor,
    Cycle,
    /// An edge names a task that isn't in the input.
    Incomplete,
}

impl Withheld {
    // codes: reasons
    pub const fn code(self) -> &'static str {
        match self {
            Withheld::NoStart => "no_start",
            Withheld::NoTasks => "no_tasks",
            Withheld::MissingEstimates => "missing_estimates",
            Withheld::CanceledPredecessor => "canceled_predecessor",
            Withheld::Cycle => "cycle",
            Withheld::Incomplete => "incomplete",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScheduledTask {
    pub id: String,
    pub duration_days: i64,
    pub earliest_start: CalendarDate,
    /// The last working day of the span, inclusive.
    pub earliest_finish: CalendarDate,
    pub latest_start: CalendarDate,
    pub latest_finish: CalendarDate,
    /// How many working days it can slip without moving the plan's finish. It isn't evidence anyone is free.
    pub slack_days: i64,
    pub critical: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Baseline {
    /// The longest dependency path, in working days, and never the sum of every estimate.
    pub duration_days: i64,
    /// The first working day on or after the start date, which is where the plan really begins.
    pub begins_on: CalendarDate,
    pub finish: CalendarDate,
    /// Sorted by task ID.
    pub tasks: Vec<ScheduledTask>,
    /// Every tied path from first to last, sorted, up to the limits above.
    pub critical_paths: Vec<Vec<String>>,
    /// Whether there were more paths than are listed.
    pub critical_paths_cut: bool,
    /// Completed tasks with no estimate, which aren't in the scenario.
    pub left_out: Vec<String>,
}

fn out_of_scenario(status: TaskStatus, days: Option<i64>) -> bool {
    status == TaskStatus::Canceled || (status == TaskStatus::Completed && days.is_none())
}

/// Works out the baseline, or every reason there can't be one, sorted.
pub fn baseline(input: &BaselineInput) -> Result<Baseline, Vec<Withheld>> {
    let mut withheld = BTreeSet::new();
    if input.start.is_none() {
        withheld.insert(Withheld::NoStart);
    }
    let known: BTreeMap<&str, &BaselineTask> =
        input.tasks.iter().map(|t| (t.id.as_str(), t)).collect();
    let scenario: Vec<&BaselineTask> = known
        .values()
        .copied()
        .filter(|t| !out_of_scenario(t.status, t.duration_days))
        .collect();
    if scenario.is_empty() {
        withheld.insert(Withheld::NoTasks);
    }
    let in_range = |days: Option<i64>| days.filter(|d| (1..=MAX_TASK_DURATION_DAYS).contains(d));
    if scenario.iter().any(|t| in_range(t.duration_days).is_none()) {
        withheld.insert(Withheld::MissingEstimates);
    }
    let in_scenario: BTreeSet<&str> = scenario.iter().map(|t| t.id.as_str()).collect();
    let mut edges: BTreeSet<(&str, &str)> = BTreeSet::new();
    for (from, to) in &input.edges {
        let Some(successor) = known.get(to.as_str()) else {
            withheld.insert(Withheld::Incomplete);
            continue;
        };
        if !in_scenario.contains(to.as_str()) {
            continue;
        }
        match known.get(from.as_str()) {
            None => {
                withheld.insert(Withheld::Incomplete);
            }
            Some(_) if in_scenario.contains(from.as_str()) => {
                edges.insert((from, to));
            }
            Some(predecessor) if predecessor.status == TaskStatus::Canceled => {
                withheld.insert(Withheld::CanceledPredecessor);
            }
            Some(_) if successor.status != TaskStatus::Completed => {
                withheld.insert(Withheld::MissingEstimates);
            }
            Some(_) => {}
        }
    }
    let graph = Graph::new(&scenario, &edges);
    let order = graph.topological();
    if order.len() != scenario.len() {
        withheld.insert(Withheld::Cycle);
    }
    if !withheld.is_empty() {
        return Err(withheld.into_iter().collect());
    }
    let Some(start) = input.start else {
        return Err(vec![Withheld::NoStart]);
    };

    let mut earliest: BTreeMap<&str, i64> = BTreeMap::new();
    for &task in &order {
        let begins = graph
            .links(&graph.before, task)
            .iter()
            .map(|&p| at(&earliest, p) + graph.days(p))
            .max()
            .unwrap_or(0);
        earliest.insert(task, begins);
    }
    let duration_days = order
        .iter()
        .map(|&task| at(&earliest, task) + graph.days(task))
        .max()
        .unwrap_or(0);
    let mut latest: BTreeMap<&str, i64> = BTreeMap::new();
    for &task in order.iter().rev() {
        let finish = graph
            .links(&graph.after, task)
            .iter()
            .map(|&s| at(&latest, s))
            .min()
            .unwrap_or(duration_days);
        latest.insert(task, finish - graph.days(task));
    }
    let times = Times {
        earliest: &earliest,
        latest: &latest,
    };
    let tasks = in_scenario
        .iter()
        .map(|&task| {
            let (first, last, days) = (at(&earliest, task), at(&latest, task), graph.days(task));
            ScheduledTask {
                id: task.to_string(),
                duration_days: days,
                earliest_start: start.working_day(first),
                earliest_finish: start.working_day(first + days - 1),
                latest_start: start.working_day(last),
                latest_finish: start.working_day(last + days - 1),
                slack_days: last - first,
                critical: last == first,
            }
        })
        .collect();
    let (critical_paths, critical_paths_cut) = critical_paths(&graph, &in_scenario, &times);
    Ok(Baseline {
        duration_days,
        begins_on: start.working_day(0),
        finish: start.working_day(duration_days - 1),
        tasks,
        critical_paths,
        critical_paths_cut,
        left_out: known
            .values()
            .filter(|t| t.status == TaskStatus::Completed && t.duration_days.is_none())
            .map(|t| t.id.clone())
            .collect(),
    })
}

fn at(times: &BTreeMap<&str, i64>, task: &str) -> i64 {
    times.get(task).copied().unwrap_or(0)
}

struct Times<'t, 'a> {
    earliest: &'t BTreeMap<&'a str, i64>,
    latest: &'t BTreeMap<&'a str, i64>,
}

impl Times<'_, '_> {
    fn critical(&self, task: &str) -> bool {
        at(self.earliest, task) == at(self.latest, task)
    }
}

/// The scenario's tasks, with each one's links sorted by ID.
struct Graph<'a> {
    days: BTreeMap<&'a str, i64>,
    before: BTreeMap<&'a str, Vec<&'a str>>,
    after: BTreeMap<&'a str, Vec<&'a str>>,
}

impl<'a> Graph<'a> {
    fn new(scenario: &[&'a BaselineTask], edges: &BTreeSet<(&'a str, &'a str)>) -> Graph<'a> {
        let mut before: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
        let mut after: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
        for &(from, to) in edges {
            before.entry(to).or_default().push(from);
            after.entry(from).or_default().push(to);
        }
        let days = scenario
            .iter()
            .map(|t| (t.id.as_str(), t.duration_days.unwrap_or(1)))
            .collect();
        Graph {
            days,
            before,
            after,
        }
    }

    fn days(&self, task: &str) -> i64 {
        self.days.get(task).copied().unwrap_or(1)
    }

    fn links<'g>(&self, links: &'g BTreeMap<&'a str, Vec<&'a str>>, task: &str) -> &'g [&'a str] {
        links.get(task).map_or(&[], Vec::as_slice)
    }

    /// Kahn's algorithm, without recursion, because a chain can be a whole room long. Anything on a loop is never reached.
    fn topological(&self) -> Vec<&'a str> {
        let mut waiting: BTreeMap<&str, usize> = self
            .days
            .keys()
            .map(|&task| (task, self.links(&self.before, task).len()))
            .collect();
        let mut ready: VecDeque<&str> = waiting
            .iter()
            .filter(|(_, &count)| count == 0)
            .map(|(&task, _)| task)
            .collect();
        let mut order = Vec::with_capacity(self.days.len());
        while let Some(task) = ready.pop_front() {
            order.push(task);
            for &next in self.links(&self.after, task) {
                if let Some(count) = waiting.get_mut(next) {
                    *count -= 1;
                    if *count == 0 {
                        ready.push_back(next);
                    }
                }
            }
        }
        order
    }
}

/// Walks only tight edges between critical tasks. Every such task reaches the finish along one, so this never hits a dead end, and
/// its work follows what it lists rather than how many ties exist.
fn critical_paths<'a>(
    graph: &Graph<'a>,
    tasks: &BTreeSet<&'a str>,
    times: &Times<'_, 'a>,
) -> (Vec<Vec<String>>, bool) {
    let next = |task: &str| -> Vec<&'a str> {
        let finish = at(times.earliest, task) + graph.days(task);
        let mut tight: Vec<&str> = graph
            .links(&graph.after, task)
            .iter()
            .copied()
            .filter(|&s| times.critical(s) && at(times.earliest, s) == finish)
            .collect();
        tight.reverse();
        tight
    };
    let mut paths = Vec::new();
    let mut ids = 0;
    let starts = tasks
        .iter()
        .copied()
        .filter(|&t| times.critical(t) && at(times.earliest, t) == 0);
    for start in starts {
        let mut path = vec![start];
        // For each task on the path, the choices still to try after it, last first.
        let mut choices = vec![next(start)];
        while let Some(options) = choices.last_mut() {
            if let Some(chosen) = options.pop() {
                path.push(chosen);
                choices.push(next(chosen));
                continue;
            }
            if path.last().is_some_and(|&t| next(t).is_empty()) {
                if paths.len() == MAX_CRITICAL_PATHS || ids + path.len() > MAX_CRITICAL_PATH_IDS {
                    return (paths, true);
                }
                ids += path.len();
                paths.push(path.iter().map(ToString::to_string).collect());
            }
            choices.pop();
            path.pop();
        }
    }
    (paths, false)
}
