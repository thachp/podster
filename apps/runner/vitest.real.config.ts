import { defineConfig } from "vitest/config";

// Only step 9(b)'s real-run verification, which spends on the owner's key and runs Docker. It still skips unless
// RUNNER_REAL_RUN=1 and RUNNER_REAL_KEY_FILE are both set. See test/claude-real.test.ts.
export default defineConfig({ test: { include: ["test/claude-real.test.ts"], testTimeout: 300000, fileParallelism: false } });
