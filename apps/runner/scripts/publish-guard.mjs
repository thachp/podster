// Runner's publish guard, npm's `prepublishOnly`. A publish of this folder goes through only from the test pre-release
// workflow on main in thachp/podster, and only for a `0.0.x-test.N` version (the owner's decision of 2026-11-19, narrowing
// decision 26). A plain `npm publish` on anyone's machine is refused. The workflow itself publishes the .tgz its build job
// packed, and npm runs no script for a .tgz, so this guard never runs there. What holds is server-side: the
// `npm-test-prerelease` environment's branch rule and reviewer, and npm's trusted publisher and package settings. This
// only stops a publish by mistake. It isn't packed.
import { readFileSync } from "node:fs";

const WORKFLOW_REF = "thachp/podster/.github/workflows/runner-prerelease.yml@refs/heads/main";
const version = process.env.npm_package_version ?? JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const refusal =
  process.env.GITHUB_ACTIONS !== "true" || process.env.GITHUB_WORKFLOW_REF !== WORKFLOW_REF
    ? "Runner is published only by the runner-prerelease workflow on main, never from a machine. See docs/runner-prerelease.md."
    : !/^0\.0\.\d+-test\.\d+$/.test(String(version))
      ? "Runner's only release is the test pre-release, versioned 0.0.x-test.N. The gated release (decision 26) isn't built."
      : null;

if (refusal) {
  process.stderr.write(`${refusal}\n`);
  process.exit(1);
}
