import { beforeEach } from "vitest";

// Each test's own time bound, kept in its meta so vitest's JSON report carries it beside the test's duration.
// e2e/test-durations.mjs reads both, in CI, and fails a test that used more than its share of the bound.
beforeEach(({ task }) => {
  (task.meta as Record<string, unknown>).bound = task.timeout;
});
