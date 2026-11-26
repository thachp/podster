import { defineConfig } from "vitest/config";

// Only the real runs, which spend on the owner's key and run Docker: step 9(b)'s verification (test/claude-real.test.ts)
// and step 12's real half (test/hostile-real.test.ts). Each spends only with RUNNER_REAL_RUN=1 and RUNNER_REAL_KEY_FILE
// both set. hostile-real's escape suite calls no provider and also runs with RUNNER_HOSTILE_DOCKER=1, as CI's runner job does.
export default defineConfig({ test: { include: ["test/claude-real.test.ts", "test/hostile-real.test.ts"], testTimeout: 300000, fileParallelism: false } });
