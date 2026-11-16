//! Test builds only (the `failpoints` feature): a room whose alarms the test runs itself (review standard 1).
//!
//! A command leaves the room's alarm due at once, and the test runtime runs it on its own, beside the test. A test that
//! then wrote the room's rows directly and ran its own pass raced that run, which took or skipped the step the test
//! asserted on. A room a test gave the table `test_alarms_manual` has its alarms under the test's control instead: the
//! runtime's own firing of the alarm does nothing there, and the job runs only when the test asks for a pass, through
//! [`INTERNAL_TEST_ALARM_PASS`]. Alarms are still set as before; one due at once is taken by that firing, which runs
//! nothing and leaves none, while a wait set ahead stays to be read.
//!
//! The module is compiled only with the feature (`mod test_alarms` is under it in `workspace.rs`), so a deployed build
//! has neither the route nor the read. Each item carries the attribute too, where the source guard in
//! `test/takedown.spec.ts` looks for it, and `test/app-hostname.spec.ts` checks this file's guards by name.

use worker::SqlStorage;

/// The test's own pass: one whole run of the room's alarm job, in its turn.
#[cfg(feature = "failpoints")]
pub(crate) const INTERNAL_TEST_ALARM_PASS: &str = "/internal/test-alarm-pass";

/// Whether the runtime's own firing of the room's alarm does nothing, because the test runs the room's passes itself.
/// A table that can't be read leaves the runtime's firing to run the job, as a room without the table has it.
#[cfg(feature = "failpoints")]
pub(super) fn held_for_the_test(sql: &SqlStorage) -> bool {
    crate::store::rows(
        sql,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_alarms_manual'",
        vec![],
    )
    .is_ok_and(|found| !found.is_empty())
}
