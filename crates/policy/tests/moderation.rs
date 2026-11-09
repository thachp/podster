use podster_policy::moderation::*;

#[test]
fn only_a_listed_person_is_an_operator() {
    let operators = parse_operators(" per_op , ,per_two");
    assert_eq!(operators, vec!["per_op", "per_two"]);
    assert!(is_operator("person", "per_op", &operators));
    assert!(!is_operator("agent", "per_op", &operators));
    assert!(!is_operator("person", "per_else", &operators));
    assert!(!is_operator("person", "", &parse_operators("")));
    assert!(parse_operators("").is_empty());
}

#[test]
fn a_report_needs_a_person_a_known_reason_a_short_note_and_room_in_the_day() {
    assert_eq!(check_report("person", "spam", None, 0), Ok(Reason::Spam));
    assert_eq!(
        check_report("agent", "spam", None, 0),
        Err(ReportRefusal::NotAPerson)
    );
    assert_eq!(
        check_report("person", "rude", None, 0),
        Err(ReportRefusal::BadReason)
    );
    let long = "x".repeat(MAX_REPORT_NOTE_BYTES + 1);
    assert_eq!(
        check_report("person", "abuse", Some(&long), 0),
        Err(ReportRefusal::NoteTooLong)
    );
    let full = "x".repeat(MAX_REPORT_NOTE_BYTES);
    assert!(check_report("person", "abuse", Some(&full), 9).is_ok());
    assert_eq!(
        check_report("person", "abuse", None, 10),
        Err(ReportRefusal::DailyLimit)
    );
    assert_eq!(ReportRefusal::DailyLimit.code(), "limit_exceeded");
}

#[test]
fn reasons_round_trip_by_name() {
    for reason in Reason::ALL {
        assert_eq!(Reason::from_name(reason.name()), Some(reason));
    }
}
