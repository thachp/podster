//! Cursors for lists that someone may see only part of. A cursor is the ID of the last row a page returned, which the caller
//! already has and which says nothing about any other row. The room looks up where that row sits. A cursor that was a row's
//! position in the whole room would let someone limited to their own rows count the ones they can't see from the gaps, so a
//! number is just a cursor that names no row.
use super::*;

/// Where a list resumes: before its first row, or after the row at this position.
pub(super) enum Resume {
    Start,
    After(i64),
}

/// Reads `name` from the query. Absent or empty is the start. A row's ID resumes after that row, and anything that isn't the ID
/// of one of `table`'s rows within `scope` answers `invalid_argument`, as an unknown activity cursor does. `position` and
/// `scope`'s column are names in this code, never input. `scope` keeps a cursor to one list, such as one task's thread.
pub(super) fn resume(
    sql: &SqlStorage,
    url: &Url,
    name: &str,
    table: &str,
    position: &str,
    scope: Option<(&str, &str)>,
) -> R<Resume> {
    let Some(value) = query_str(url, name).filter(|value| !value.is_empty()) else {
        return Ok(Resume::Start);
    };
    require_id(&value)?;
    let (within, values) = match scope {
        Some((column, equals)) => (
            format!(" AND {column} = ?"),
            vec![value.as_str().into(), equals.into()],
        ),
        None => (String::new(), vec![value.as_str().into()]),
    };
    rows(
        sql,
        &format!("SELECT {position} AS position FROM {table} WHERE id = ?{within}"),
        values,
    )?
    .first()
    .map(|row| Resume::After(int(&row["position"])))
    .ok_or_else(ApiError::invalid_argument)
}
