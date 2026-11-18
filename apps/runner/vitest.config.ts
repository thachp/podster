import { defineConfig } from "vitest/config";

// Runner's own tests, in plain Node. The pairing run against the real gateway and API is apps/gateway/test/runner-core.spec.ts.
export default defineConfig({ test: { include: ["test/**/*.test.ts"], testTimeout: 10000 } });
