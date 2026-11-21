#![allow(clippy::unwrap_used, clippy::indexing_slicing)]
//! The baseline forecast, mostly on the worked example in TASK-PLANNING.md: Nov 2 2026 is a Monday.
use podster_core::baseline::{
    baseline, validate_plan_start, BaselineInput, BaselineTask, CalendarDate, Withheld,
    MAX_CRITICAL_PATHS,
};
use podster_core::TaskStatus::{self, *};

fn date(text: &str) -> CalendarDate {
    CalendarDate::parse(text).unwrap()
}

fn task(id: &str, days: i64) -> BaselineTask {
    BaselineTask {
        id: id.into(),
        status: Accepted,
        duration_days: Some(days),
    }
}

fn with(id: &str, status: TaskStatus, days: Option<i64>) -> BaselineTask {
    BaselineTask {
        id: id.into(),
        status,
        duration_days: days,
    }
}

fn plan(start: &str, tasks: Vec<BaselineTask>, edges: &[(&str, &str)]) -> BaselineInput {
    BaselineInput {
        start: Some(date(start)),
        tasks,
        edges: edges
            .iter()
            .map(|(a, b)| ((*a).to_string(), (*b).to_string()))
            .collect(),
    }
}

fn worked_example() -> BaselineInput {
    plan(
        "2026-11-02",
        vec![
            task("101", 1),
            task("102", 2),
            task("103", 1),
            task("104", 2),
            task("105", 2),
            task("106", 4),
            task("107", 2),
            task("108", 1),
        ],
        &[
            ("101", "103"),
            ("103", "104"),
            ("102", "105"),
            ("104", "106"),
            ("105", "106"),
            ("106", "107"),
            ("106", "108"),
        ],
    )
}

#[test]
fn the_worked_example_gives_the_spans_the_spec_lists() {
    let forecast = baseline(&worked_example()).unwrap();
    assert_eq!(
        forecast.duration_days, 10,
        "the longest path, not the 15 they sum to"
    );
    assert_eq!(forecast.begins_on, date("2026-11-02"));
    assert_eq!(forecast.finish, date("2026-11-13"));
    let spans: Vec<(String, String, String)> = forecast
        .tasks
        .iter()
        .map(|t| {
            (
                t.id.clone(),
                t.earliest_start.to_string(),
                t.earliest_finish.to_string(),
            )
        })
        .collect();
    let want = [
        ("101", "2026-11-02", "2026-11-02"),
        ("102", "2026-11-02", "2026-11-03"),
        ("103", "2026-11-03", "2026-11-03"),
        ("104", "2026-11-04", "2026-11-05"),
        ("105", "2026-11-04", "2026-11-05"),
        ("106", "2026-11-06", "2026-11-11"),
        ("107", "2026-11-12", "2026-11-13"),
        ("108", "2026-11-12", "2026-11-12"),
    ]
    .map(|(a, b, c)| (a.to_string(), b.to_string(), c.to_string()));
    assert_eq!(spans, want);
}

#[test]
fn both_tied_critical_paths_are_listed_and_only_the_short_branch_has_slack() {
    let forecast = baseline(&worked_example()).unwrap();
    assert_eq!(
        forecast.critical_paths,
        vec![
            vec!["101", "103", "104", "106", "107"],
            vec!["102", "105", "106", "107"],
        ]
    );
    assert!(!forecast.critical_paths_cut);
    for t in &forecast.tasks {
        let (slack, critical) = if t.id == "108" { (1, false) } else { (0, true) };
        assert_eq!((t.slack_days, t.critical), (slack, critical), "{}", t.id);
    }
    let late = forecast.tasks.iter().find(|t| t.id == "108").unwrap();
    assert_eq!(late.latest_start, date("2026-11-13"));
    assert_eq!(late.latest_finish, date("2026-11-13"));
}

#[test]
fn slack_is_counted_in_working_days_across_a_weekend() {
    // `a` takes Mon to Fri, and `b` can start as late as Friday, which is 4 working days of slack.
    let forecast = baseline(&plan("2026-11-02", vec![task("a", 5), task("b", 1)], &[])).unwrap();
    let b = &forecast.tasks[1];
    assert_eq!(b.slack_days, 4);
    assert_eq!(b.latest_start, date("2026-11-06"));
    assert_eq!(forecast.critical_paths, vec![vec!["a"]]);
}

#[test]
fn independent_tasks_run_side_by_side_and_each_longest_ties() {
    let forecast = baseline(&plan(
        "2026-11-02",
        vec![task("a", 3), task("b", 3), task("c", 1)],
        &[],
    ))
    .unwrap();
    assert_eq!(forecast.duration_days, 3);
    assert_eq!(forecast.critical_paths, vec![vec!["a"], vec!["b"]]);
}

#[test]
fn input_order_changes_nothing() {
    let want = baseline(&worked_example()).unwrap();
    let mut shuffled = worked_example();
    shuffled.tasks.reverse();
    shuffled.edges.reverse();
    let repeated = shuffled.edges[0].clone();
    shuffled.edges.push(repeated);
    assert_eq!(baseline(&shuffled).unwrap(), want);
}

#[test]
fn weekends_are_skipped_and_a_weekend_start_begins_on_monday() {
    assert_eq!(date("2026-11-06").working_day(1), date("2026-11-09"));
    assert_eq!(date("2026-11-02").working_day(4), date("2026-11-06"));
    assert_eq!(date("2026-11-02").working_day(5), date("2026-11-09"));
    assert_eq!(date("2026-11-02").working_day(260), date("2027-11-01"));
    for weekend in ["2026-11-07", "2026-11-08"] {
        assert_eq!(date(weekend).working_day(0), date("2026-11-09"));
        let forecast = baseline(&plan(weekend, vec![task("a", 1)], &[])).unwrap();
        assert_eq!(forecast.begins_on, date("2026-11-09"));
        assert_eq!(forecast.finish, date("2026-11-09"));
    }
    // Every day of a stretch: never a weekend, and always the next working day.
    let mut last = date("2024-02-26").working_day(0);
    for index in 1..2_000 {
        let day = date("2024-02-26").working_day(index);
        let text = day.to_string();
        assert!(!["Sat", "Sun"].contains(&weekday_name(&text)), "{text}");
        assert!(day > last);
        last = day;
    }
}

#[test]
fn a_coordinators_baseline_and_estimates_date_implementation_then_qa_then_demo_packaging() {
    // Issue 507's room: a coordinator sets the start and estimates the owner's tasks. Monday Nov 23 2026; Thanksgiving counts.
    let input = BaselineInput {
        start: Some(validate_plan_start("2026-11-23", "America/New_York").unwrap()),
        tasks: vec![
            with("demo_packaging", Open, Some(1)),
            with("implementation", Accepted, Some(3)),
            with("qa", Offered, Some(2)),
        ],
        edges: vec![
            ("implementation".into(), "qa".into()),
            ("qa".into(), "demo_packaging".into()),
        ],
    };
    let forecast = baseline(&input).unwrap();
    let span = |id: &str| {
        let t = forecast.tasks.iter().find(|t| t.id == id).unwrap();
        (
            t.earliest_start.to_string(),
            t.earliest_finish.to_string(),
            t.critical,
        )
    };
    assert_eq!(
        span("implementation"),
        ("2026-11-23".into(), "2026-11-25".into(), true)
    );
    assert_eq!(span("qa"), ("2026-11-26".into(), "2026-11-27".into(), true));
    assert_eq!(
        span("demo_packaging"),
        ("2026-11-30".into(), "2026-11-30".into(), true)
    );
    assert_eq!(forecast.duration_days, 6);
    assert_eq!(forecast.finish, date("2026-11-30"));
    assert_eq!(
        forecast.critical_paths,
        vec![vec!["implementation", "qa", "demo_packaging"]]
    );
    // Without the start, or with an estimate missing, there's no forecast to show.
    let unstarted = BaselineInput {
        start: None,
        ..input.clone()
    };
    assert_eq!(baseline(&unstarted).unwrap_err(), vec![Withheld::NoStart]);
    let mut unestimated = input;
    unestimated.tasks[0].duration_days = None;
    assert_eq!(
        baseline(&unestimated).unwrap_err(),
        vec![Withheld::MissingEstimates]
    );
}

#[test]
fn a_holiday_counts_as_a_working_day() {
    // Friday December 25 2026, then the next working day is Monday.
    assert_eq!(date("2026-12-25").working_day(0), date("2026-12-25"));
    assert_eq!(date("2026-12-24").working_day(1), date("2026-12-25"));
    assert_eq!(date("2026-12-24").working_day(2), date("2026-12-28"));
}

/// Worked out separately from the code under test, with Zeller's congruence.
fn weekday_name(text: &str) -> &'static str {
    let (y, m, d): (i64, i64, i64) = (
        text[0..4].parse().unwrap(),
        text[5..7].parse().unwrap(),
        text[8..10].parse().unwrap(),
    );
    let (y, m) = if m < 3 { (y - 1, m + 12) } else { (y, m) };
    let h = (d + 13 * (m + 1) / 5 + y + y / 4 - y / 100 + y / 400) % 7;
    ["Sat", "Sun", "Mon", "Tue", "Wed", "Thu", "Fri"][h as usize]
}

#[test]
fn dates_round_trip_and_only_real_ones_parse() {
    for text in [
        "2024-02-29",
        "2000-01-01",
        "2100-12-31",
        "1970-01-01",
        "1999-12-31",
    ] {
        assert_eq!(date(text).to_string(), text);
    }
    for bad in [
        "2026-02-29",
        "2100-02-29",
        "2026-13-01",
        "2026-00-10",
        "2026-04-31",
        "2026-1-01",
        "26-01-01",
        "2026/01/01",
        "2026-01-01T00:00",
        "",
        "abcd-ef-gh",
        "٢٠٢٦-01-01",
    ] {
        assert_eq!(CalendarDate::parse(bad), None, "{bad}");
    }
}

#[test]
fn a_start_is_a_date_in_range_and_a_timezone_name() {
    assert!(validate_plan_start("2026-11-02", "America/New_York").is_ok());
    assert!(validate_plan_start("2026-11-02", "UTC").is_ok());
    assert!(validate_plan_start("2026-11-02", "Etc/GMT+5").is_ok());
    assert!(validate_plan_start("2026-11-02", "America/Argentina/Buenos_Aires").is_ok());
    assert!(validate_plan_start("2000-01-01", "UTC").is_ok());
    assert!(validate_plan_start("2100-12-31", "UTC").is_ok());
    for (day, zone) in [
        ("1999-12-31", "UTC"),
        ("2101-01-01", "UTC"),
        ("2026-02-30", "UTC"),
        ("2026-11-02", ""),
        ("2026-11-02", "+01:00"),
        ("2026-11-02", "-05"),
        ("2026-11-02", "America/"),
        ("2026-11-02", "/UTC"),
        ("2026-11-02", "America//New_York"),
        ("2026-11-02", "../etc/passwd"),
        ("2026-11-02", "New York"),
        ("2026-11-02", "Zürich"),
    ] {
        assert!(validate_plan_start(day, zone).is_err(), "{day} {zone}");
    }
    assert!(validate_plan_start("2026-11-02", &"A".repeat(65)).is_err());
}

#[test]
fn every_reason_is_reported_and_nothing_is_dated() {
    let no_start = BaselineInput {
        start: None,
        ..worked_example()
    };
    assert_eq!(baseline(&no_start).unwrap_err(), vec![Withheld::NoStart]);
    let empty = plan("2026-11-02", vec![], &[]);
    assert_eq!(baseline(&empty).unwrap_err(), vec![Withheld::NoTasks]);
    let unestimated = plan("2026-11-02", vec![task("a", 1), with("b", Open, None)], &[]);
    assert_eq!(
        baseline(&unestimated).unwrap_err(),
        vec![Withheld::MissingEstimates]
    );
    let looped = plan(
        "2026-11-02",
        vec![task("a", 1), task("b", 1), task("c", 1)],
        &[("a", "b"), ("b", "a")],
    );
    assert_eq!(baseline(&looped).unwrap_err(), vec![Withheld::Cycle]);
    let itself = plan("2026-11-02", vec![task("a", 1)], &[("a", "a")]);
    assert_eq!(baseline(&itself).unwrap_err(), vec![Withheld::Cycle]);
    let unknown = plan("2026-11-02", vec![task("a", 1)], &[("gone", "a")]);
    assert_eq!(baseline(&unknown).unwrap_err(), vec![Withheld::Incomplete]);
    let all = BaselineInput {
        start: None,
        tasks: vec![
            with("a", Open, None),
            task("b", 1),
            task("c", 1),
            with("x", Canceled, Some(1)),
        ],
        edges: vec![
            ("b".into(), "c".into()),
            ("c".into(), "b".into()),
            ("x".into(), "c".into()),
            ("gone".into(), "c".into()),
        ],
    };
    assert_eq!(
        baseline(&all).unwrap_err(),
        vec![
            Withheld::NoStart,
            Withheld::MissingEstimates,
            Withheld::CanceledPredecessor,
            Withheld::Cycle,
            Withheld::Incomplete
        ]
    );
}

#[test]
fn a_duration_outside_the_rule_counts_as_no_estimate_and_never_as_zero() {
    for days in [0, -1, 261] {
        let bad = plan("2026-11-02", vec![task("a", days)], &[]);
        assert_eq!(
            baseline(&bad).unwrap_err(),
            vec![Withheld::MissingEstimates],
            "{days}"
        );
    }
    assert!(baseline(&plan("2026-11-02", vec![task("a", 260)], &[])).is_ok());
}

#[test]
fn a_canceled_predecessor_withholds_until_it_is_removed_and_never_shortens_the_plan() {
    let tasks = || vec![with("x", Canceled, Some(9)), task("a", 1)];
    assert_eq!(
        baseline(&plan("2026-11-02", tasks(), &[("x", "a")])).unwrap_err(),
        vec![Withheld::CanceledPredecessor]
    );
    // A completed successor's canceled predecessor can still be removed, so that's withheld too.
    let done = vec![with("x", Canceled, Some(9)), with("a", Completed, Some(1))];
    assert_eq!(
        baseline(&plan("2026-11-02", done, &[("x", "a")])).unwrap_err(),
        vec![Withheld::CanceledPredecessor]
    );
    let removed = baseline(&plan("2026-11-02", tasks(), &[])).unwrap();
    assert_eq!(
        removed.duration_days, 1,
        "a canceled task with no successor isn't in the scenario"
    );
    assert_eq!(removed.tasks.len(), 1);
    assert!(removed.left_out.is_empty());
    // A canceled task's own predecessors don't matter either.
    let behind = plan(
        "2026-11-02",
        vec![task("a", 1), with("x", Canceled, None)],
        &[("a", "x")],
    );
    assert_eq!(baseline(&behind).unwrap().duration_days, 1);
}

#[test]
fn a_finished_task_with_no_estimate_is_left_out_rather_than_withholding_the_room_for_good() {
    let old = || with("old", Completed, None);
    let forecast = baseline(&plan("2026-11-02", vec![old(), task("a", 2)], &[])).unwrap();
    assert_eq!(forecast.left_out, vec!["old"]);
    assert_eq!(forecast.duration_days, 2);
    // Something still to do depends on an unknown, and someone can fix that.
    assert_eq!(
        baseline(&plan(
            "2026-11-02",
            vec![old(), task("a", 2)],
            &[("old", "a")]
        ))
        .unwrap_err(),
        vec![Withheld::MissingEstimates]
    );
    // Nobody can edit an edge between two finished tasks, so it can't be allowed to withhold the plan.
    let closed = baseline(&plan(
        "2026-11-02",
        vec![old(), with("done", Completed, Some(3)), task("a", 1)],
        &[("old", "done")],
    ))
    .unwrap();
    assert_eq!(closed.duration_days, 3);
    // Only the room's own history: a room of nothing else has no scenario.
    assert_eq!(
        baseline(&plan("2026-11-02", vec![old()], &[])).unwrap_err(),
        vec![Withheld::NoTasks]
    );
}

#[test]
fn a_task_left_out_never_counts_toward_the_duration() {
    let without = baseline(&plan(
        "2026-11-02",
        vec![with("done", Completed, Some(3)), task("a", 2)],
        &[],
    ))
    .unwrap();
    // On its own, and ahead of a finished task, where counting it as any length at all would move the finish.
    let with_it = baseline(&plan(
        "2026-11-02",
        vec![
            with("old", Completed, None),
            with("done", Completed, Some(3)),
            task("a", 2),
        ],
        &[("old", "done")],
    ))
    .unwrap();
    assert_eq!(with_it.duration_days, without.duration_days);
    assert_eq!(with_it.finish, without.finish);
    assert_eq!(with_it.tasks, without.tasks);
    assert_eq!(with_it.critical_paths, without.critical_paths);
    assert_eq!(with_it.left_out, vec!["old"]);
    assert!(without.left_out.is_empty());
}

#[test]
fn status_never_moves_a_date() {
    let want = baseline(&worked_example()).unwrap();
    for status in [Open, Offered, Submitted, Completed] {
        let mut input = worked_example();
        for t in &mut input.tasks {
            t.status = status;
        }
        assert_eq!(baseline(&input).unwrap(), want, "{status:?}");
    }
}

#[test]
fn ties_that_multiply_are_cut_and_every_task_still_says_it_is_critical() {
    // 30 diamonds in a row tie 2^30 ways, so this also proves listing them doesn't walk them all.
    let mut tasks = vec![task("n00", 1)];
    let mut edges = Vec::new();
    for i in 0..30 {
        let (from, a, b, to) = (
            format!("n{i:02}"),
            format!("a{i:02}"),
            format!("b{i:02}"),
            format!("n{:02}", i + 1),
        );
        tasks.extend([task(&a, 1), task(&b, 1), task(&to, 1)]);
        edges.extend([
            (from.clone(), a.clone()),
            (from, b.clone()),
            (a, to.clone()),
            (b, to),
        ]);
    }
    let input = BaselineInput {
        start: Some(date("2026-11-02")),
        tasks,
        edges,
    };
    let forecast = baseline(&input).unwrap();
    assert_eq!(forecast.critical_paths.len(), MAX_CRITICAL_PATHS);
    assert!(forecast.critical_paths_cut);
    assert!(forecast
        .tasks
        .iter()
        .all(|t| t.critical && t.slack_days == 0));
    assert_eq!(
        forecast.critical_paths,
        baseline(&input).unwrap().critical_paths
    );
}

#[test]
fn exactly_as_many_ties_as_the_limit_is_not_cut() {
    let tasks: Vec<_> = (0..MAX_CRITICAL_PATHS)
        .map(|i| task(&format!("t{i:02}"), 1))
        .collect();
    let forecast = baseline(&plan("2026-11-02", tasks, &[])).unwrap();
    assert_eq!(forecast.critical_paths.len(), MAX_CRITICAL_PATHS);
    assert!(!forecast.critical_paths_cut);
}

#[test]
fn the_longest_plan_a_room_allows_has_real_dates() {
    let ids: Vec<String> = (0..3_000).map(|i| format!("t{i:04}")).collect();
    let tasks = ids.iter().map(|id| task(id, 260)).collect();
    let edges = ids
        .windows(2)
        .map(|w| (w[0].clone(), w[1].clone()))
        .collect();
    let input = BaselineInput {
        start: CalendarDate::parse("2100-12-31"),
        tasks,
        edges,
    };
    let forecast = baseline(&input).unwrap();
    assert_eq!(forecast.duration_days, 780_000);
    assert_eq!(forecast.critical_paths[0].len(), 3_000);
    let finish = forecast.finish.to_string();
    assert_eq!(finish.len(), 10, "{finish}");
    assert_eq!(CalendarDate::parse(&finish), Some(forecast.finish));
}
