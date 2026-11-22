import { defineConfig } from "vitest/config";

// Only the proofs on a real Docker Engine: S-47's Linux proof (test/linux-docker.test.ts), which builds Runner's images and
// starts containers, the egress proxy's (test/egress-docker.test.ts), which also reaches registry.npmjs.org, and the
// toolchain images' (test/toolchains-docker.test.ts), which builds them and runs cargo, uv, dotnet, javac and mvn in them. Never in the
// default run. CI's `runner` job runs all three on GitHub's Ubuntu runner with RUNNER_LINUX_DOCKER=1; the first skips on
// any other system or without that variable, the second runs on a Mac too with RUNNER_EGRESS_DOCKER=1, and the third
// with RUNNER_TOOLCHAIN_DOCKER=1. Runner on a real Git 2.25 in `ubuntu:20.04` (test/old-git.test.ts) runs here too, and on a
// Mac with RUNNER_OLD_GIT_DOCKER=1. No provider is called.
export default defineConfig({ test: { include: ["test/linux-docker.test.ts", "test/egress-docker.test.ts", "test/toolchains-docker.test.ts", "test/old-git.test.ts"], testTimeout: 900000, hookTimeout: 2400000, fileParallelism: false } });
