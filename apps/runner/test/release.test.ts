// The test pre-release (the owner's decision of 2026-11-19, narrowing decision 26): Runner points at staging unless the
// owner names another gateway, and a publish is refused anywhere but the pre-release workflow on main.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_GATEWAY, pairingGateway } from "../src/core/gateway.js";
import { CEILINGS, DAY_SPEND_CEILING_MICRO_USD, parsePolicyConfig } from "../src/core/policy.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as Record<string, any>;

describe("the default gateway", () => {
  it("is staging's gateway", () => {
    expect(DEFAULT_GATEWAY).toBe("https://gateway-staging.podster.dev");
    expect(pairingGateway(undefined)).toBe("https://gateway-staging.podster.dev");
  });

  it("gives way to the gateway the owner names, checked the same way", () => {
    expect(pairingGateway("http://localhost:8787")).toBe("http://localhost:8787");
    expect(pairingGateway("https://podster.dev/")).toBe("https://podster.dev");
    expect(() => pairingGateway("http://podster.dev")).toThrow();
    expect(() => pairingGateway("https://podster.dev/api")).toThrow();
  });
});

describe("the package", () => {
  it("is the marked test pre-release, published under the test tag", () => {
    expect(pkg.name).toBe("podster");
    expect(pkg.private).toBeUndefined();
    expect(pkg.version).toMatch(/^0\.0\.\d+-test\.\d+$/);
    expect(pkg.publishConfig).toEqual({ access: "public", tag: "test", provenance: true });
    expect(pkg.bin).toEqual({ podster: "build/node/cli.js" });
    expect(pkg.files).toEqual(["build/", "git/credential-helper", "sandbox/Dockerfile", "claude-image/Dockerfile",
      "proxy-image/Dockerfile", "toolchains/dotnet/Dockerfile", "toolchains/java/Dockerfile", "toolchains/python/Dockerfile", "toolchains/rust/Dockerfile", "README.md"]);
    expect(pkg.repository).toEqual({ type: "git", url: "git+https://github.com/thachp/podster.git", directory: "apps/runner" });
  });

  it("starts its command line with a shebang", () => {
    expect(readFileSync(new URL("../src/node/cli.ts", import.meta.url), "utf8").startsWith("#!/usr/bin/env node\n")).toBe(true);
  });
});

describe("the shipped dependencies", () => {
  // Runner bundles its production tree, installed from package-lock.json by `npm ci` with integrity checked, so an install
  // gets exactly what CI tested (security review M2 on #470). It doesn't ship npm-shrinkwrap.json: npm reads a dependency's
  // shrinkwrap after its per-platform check, so 0.0.1-test.11 installed every entry, all eight Claude Code binaries and
  // the dev tools, 3.8 GB. scripts/pack.mjs packs the bundle and scripts/install-check.mjs checks a real install.
  type Entry = { version?: string; resolved?: string; integrity?: string; dev?: boolean; optional?: boolean; hasInstallScript?: boolean; optionalDependencies?: Record<string, string> };
  const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8")) as { name: string; version: string; packages: Record<string, Entry> };
  const production = Object.entries(lock.packages).filter(([path, entry]) => path !== "" && !entry.dev);
  const SDK = "@anthropic-ai/claude-agent-sdk";

  it("ships no npm-shrinkwrap.json", () => {
    expect(existsSync(new URL("../npm-shrinkwrap.json", import.meta.url))).toBe(false);
  });

  it("bundles every production dependency, exactly pinned, and nothing else", () => {
    expect(pkg.bundleDependencies).toEqual(Object.keys(pkg.dependencies));
    for (const [name, spec] of Object.entries(pkg.dependencies as Record<string, string>)) expect([name, spec]).toEqual([name, expect.stringMatching(/^\d+\.\d+\.\d+$/)]);
  });

  it("names the SDK's platform packages as its own optional dependencies, at the SDK's version, so npm picks the host's", () => {
    const sdk = lock.packages[`node_modules/${SDK}`];
    expect(sdk.version).toBe(pkg.dependencies[SDK]);
    expect(pkg.optionalDependencies).toEqual(sdk.optionalDependencies);
    expect(Object.keys(pkg.optionalDependencies).length).toBe(8);
    for (const [name, version] of Object.entries(pkg.optionalDependencies as Record<string, string>)) {
      expect([name, version]).toEqual([`${SDK}-${name.slice(SDK.length + 1)}`, sdk.version]);
      expect([name, lock.packages[`node_modules/${name}`]?.optional]).toEqual([name, true]);
    }
  });

  it("resolves every production package by integrity, from npm's registry", () => {
    expect(production.length).toBeGreaterThan(50);
    for (const [path, entry] of production) {
      expect([path, entry.integrity]).toEqual([path, expect.stringMatching(/^sha512-/)]);
      expect([path, entry.resolved]).toEqual([path, expect.stringMatching(/^https:\/\/registry\.npmjs\.org\//)]);
    }
    expect([lock.name, lock.version]).toEqual([pkg.name, pkg.version]);
  });

  it("has no production package with an install script, so Runner installs with scripts off", () => {
    expect(production.filter(([, entry]) => entry.hasInstallScript).map(([path]) => path)).toEqual([]);
  });
});

describe("the publish guard", () => {
  const WORKFLOW = "thachp/podster/.github/workflows/runner-prerelease.yml@refs/heads/main";
  const guard = (env: Record<string, string>) =>
    spawnSync(process.execPath, ["scripts/publish-guard.mjs"], { cwd: root, env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8" }).status;

  it("is what npm runs before a publish", () => {
    expect(pkg.scripts.prepublishOnly).toBe("node scripts/publish-guard.mjs");
  });

  it("refuses a publish from this machine", () => {
    expect(guard({})).not.toBe(0);
    expect(guard({ GITHUB_ACTIONS: "true" })).not.toBe(0);
    expect(guard({ GITHUB_WORKFLOW_REF: WORKFLOW })).not.toBe(0);
  });

  it("refuses another workflow, another branch or another repository", () => {
    expect(guard({ GITHUB_ACTIONS: "true", GITHUB_WORKFLOW_REF: "thachp/podster/.github/workflows/ci.yml@refs/heads/main" })).not.toBe(0);
    expect(guard({ GITHUB_ACTIONS: "true", GITHUB_WORKFLOW_REF: "thachp/podster/.github/workflows/runner-prerelease.yml@refs/heads/feat/x" })).not.toBe(0);
    expect(guard({ GITHUB_ACTIONS: "true", GITHUB_WORKFLOW_REF: "someone/podster/.github/workflows/runner-prerelease.yml@refs/heads/main" })).not.toBe(0);
    expect(guard({ GITHUB_ACTIONS: "true", GITHUB_WORKFLOW_REF: `${WORKFLOW}x` })).not.toBe(0);
  });

  it("refuses a version that isn't a test pre-release, even from the workflow", () => {
    for (const version of ["0.0.1", "1.0.0", "0.0.1-beta.1", "0.1.0-test.1"]) expect(guard({ GITHUB_ACTIONS: "true", GITHUB_WORKFLOW_REF: WORKFLOW, npm_package_version: version })).not.toBe(0);
  });

  it("lets the pre-release workflow on main publish", () => {
    expect(guard({ GITHUB_ACTIONS: "true", GITHUB_WORKFLOW_REF: WORKFLOW })).toBe(0);
    expect(guard({ GITHUB_ACTIONS: "true", GITHUB_WORKFLOW_REF: WORKFLOW, npm_package_version: pkg.version })).toBe(0);
  });
});

describe("the README's run policy example", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const section = readme.slice(readme.indexOf("## Your run policy (`policy.json`)"));
  const block = /```json\n([\s\S]*?)\n```/.exec(section)?.[1];

  it("is there, and it parses once the placeholders are real IDs", () => {
    expect(block).toBeDefined();
    const text = (block as string).replace("org_…", "org_example").replace("ws_…", "ws_example");
    expect(text).not.toContain("…");
    const parsed = parsePolicyConfig(JSON.parse(text), { runner_home: "/Users/you/.podster-runner" });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.rooms).toHaveLength(1);
      expect(parsed.value.rooms[0]).toMatchObject({ mode: "ask", outputs: "hold", network: [], repository: null, allowed_orgs: [] });
      expect(parsed.value.caps.spend_micro_usd).toBe(500_000);
    }
  });

  it("shows the key-file recipe and the field table's ceilings", () => {
    expect(section).toContain("read -rs k");
    expect(section).toContain("chmod 600");
    expect(section).toContain("head -c 7");
    expect(section).toContain(String(CEILINGS.spend_micro_usd));
    expect(section).toContain(String(CEILINGS.run_time_ms));
    expect(section).toContain(String(CEILINGS.max_tokens));
    expect(section).toContain(String(DAY_SPEND_CEILING_MICRO_USD));
  });
});
