import { configDefaults, defineConfig } from "vitest/config";

// Runner's own tests, in plain Node. The pairing run against the real gateway and API is apps/gateway/test/runner-core.spec.ts.
// The real-run verification spends on the owner's key and runs Docker, so it is never in the default run: it has its
// own config, vitest.real.config.ts, and needs RUNNER_REAL_RUN=1 and a key file as well (L7 on #460). So does step 12's
// real half, the subprocess escape suite and the injections against the real provider.
export default defineConfig({ test: { include: ["test/**/*.test.ts"], exclude: [...configDefaults.exclude, "test/claude-real.test.ts", "test/hostile-real.test.ts"], testTimeout: 10000 } });
