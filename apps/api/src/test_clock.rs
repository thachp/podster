//! Test builds only (the `failpoints` feature): clocks a test can pass in, read from `test_*` tables the test makes in a
//! room, as the other failpoints are. A release build has none of this, and reads its timeouts and its clock as before.

use crate::error::ApiError;
use crate::store::rows;
use serde_json::Value;
use std::cell::Cell;
use worker::SqlStorage;

thread_local! {
    static CALL_TIMEOUT_MS: Cell<Option<u64>> = const { Cell::new(None) };
}

/// While the guard lives, a call's timeout is the room's `test_call_timeout (ms, only)`, if it has a row for every call
/// (`only` null) or for this one (`only` = `call`), and never longer than the release timeout. Only the wait for the
/// timeout is shorter: a hung call still hangs until it fires.
pub(crate) fn shorten_calls(sql: &SqlStorage, call: &str) -> Shortened {
    let ms = rows(
        sql,
        "SELECT ms FROM test_call_timeout WHERE only IS NULL OR only = ?",
        vec![call.into()],
    )
    .ok()
    .and_then(|found| found.first().and_then(|row| row["ms"].as_u64()));
    CALL_TIMEOUT_MS.with(|cell| cell.set(ms));
    Shortened
}

/// Ends `shorten_calls` when dropped.
pub(crate) struct Shortened;

impl Drop for Shortened {
    fn drop(&mut self) {
        CALL_TIMEOUT_MS.with(|cell| cell.set(None));
    }
}

/// The timeout for a call: `release_ms`, or the shorter one a room's guard set.
pub(crate) fn call_timeout_ms(release_ms: u64) -> u64 {
    CALL_TIMEOUT_MS
        .with(Cell::get)
        .map_or(release_ms, |ms| ms.min(release_ms))
}

/// The room's clock for its scan passes, `test_scan_now (at)`, if a test passed one in.
pub(crate) fn scan_now(sql: &SqlStorage) -> Result<Option<i64>, ApiError> {
    let table = rows(
        sql,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_scan_now'",
        vec![],
    )?;
    if table.is_empty() {
        return Ok(None);
    }
    Ok(rows(sql, "SELECT at FROM test_scan_now", vec![])?
        .first()
        .and_then(|row: &Value| row["at"].as_i64()))
}
