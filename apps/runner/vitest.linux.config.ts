import { defineConfig } from "vitest/config";

// Only S-47's Linux proof on a real Docker Engine (test/linux-docker.test.ts): it builds Runner's two images and starts
// containers, so it is never in the default run. CI's `runner` job runs it on GitHub's Ubuntu runner with
// RUNNER_LINUX_DOCKER=1; it skips on any other system or without that variable. No provider is called.
export default defineConfig({ test: { include: ["test/linux-docker.test.ts"], testTimeout: 900000, hookTimeout: 2400000, fileParallelism: false } });
