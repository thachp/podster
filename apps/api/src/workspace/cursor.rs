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

/// Reads `name` from the query. Absent or empty is the start. A row's ID resumes after that row, but only a row of `table`
/// within `scope` that `visible` says the caller may be shown. Anything else answers `invalid_argument`, the same as an ID
/// that names nothing, so a cursor can't confirm that a hidden row exists or where it sits. `position` and `scope`'s column
/// are names in this code, never input. `scope` keeps a cursor to one list, such as one task's thread.
pub(super) fn resume(
    sql: &SqlStorage,
    url: &Url,
    name: &str,
    table: &str,
    position: &str,
    scope: Option<(&str, &str)>,
    visible: impl FnOnce(&str) -> R<bool>,
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
    let found = rows(
        sql,
        &format!("SELECT {position} AS position FROM {table} WHERE id = ?{within}"),
        values,
    )?
    .first()
    .map(|row| int(&row["position"]));
    match found {
        Some(at) if visible(&value)? => Ok(Resume::After(at)),
        _ => Err(ApiError::invalid_argument()),
    }
}

/// A page of what the caller is shown, and the cursor to the next, which is the last row they were shown, never one they
/// weren't. `fetch` reads up to `PAGE_SIZE + 1` rows past a position, in the list's order, each with its `id` and its
/// `position`. `show` answers what the caller gets of a row, or `None` for one they mayn't see. Rows are read on, batch after
/// batch, until the page is full and one more shown row is found, or the table ends. So a stretch of dropped rows can't end
/// a list early, can't loop, and never becomes a cursor. Each list's query is already narrowed to what `show` allows, so a
/// drop is rare and the scan stays short.
pub(super) fn page(
    sql: &SqlStorage,
    mut position: i64,
    mut fetch: impl FnMut(i64) -> R<Vec<Value>>,
    mut show: impl FnMut(&Value) -> R<Option<Value>>,
) -> R<(Vec<Value>, Option<String>)> {
    let mut shown = Vec::new();
    let mut last = None;
    loop {
        let batch = fetch(position)?;
        let ran_out = batch.len() as i64 <= PAGE_SIZE;
        for row in &batch {
            position = int(&row["position"]);
            if dropped_for_test(sql, row)? {
                continue;
            }
            if let Some(item) = show(row)? {
                if shown.len() as i64 == PAGE_SIZE {
                    return Ok((shown, last));
                }
                last = text(&row["id"]);
                shown.push(item);
            }
        }
        if ran_out {
            return Ok((shown, None));
        }
    }
}

/// Tests only: rows whose IDs are in `test_hide_from_lists` are dropped as if `show` refused them. Every list's query is
/// narrowed to what its check allows, so no real row reaches that path, and this is how a test does.
#[cfg(feature = "failpoints")]
fn dropped_for_test(sql: &SqlStorage, row: &Value) -> R<bool> {
    let exists = !rows(
        sql,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_hide_from_lists'",
        vec![],
    )?
    .is_empty();
    Ok(exists
        && !rows(
            sql,
            "SELECT 1 FROM test_hide_from_lists WHERE id = ?",
            vec![row["id"].as_str().unwrap_or_default().into()],
        )?
        .is_empty())
}

#[cfg(not(feature = "failpoints"))]
fn dropped_for_test(_sql: &SqlStorage, _row: &Value) -> R<bool> {
    Ok(false)
}
