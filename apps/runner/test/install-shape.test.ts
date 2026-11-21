// What an install of Runner's package may hold (scripts/install-shape.mjs). The real install is checked by
// scripts/install-check.mjs, in CI's runner job and the pre-release workflow; these are its rules on made-up trees.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bundledNames, devOnlyNames, hostPlatformPackage, installedPackages, installProblems, tarballProblems, type Lock } from "../scripts/install-shape.mjs";

const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8")) as Lock;
const devOnly = devOnlyNames(lock);
const SDK = "@anthropic-ai/claude-agent-sdk";
const supported = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-arm64-musl", "linux-x64", "linux-x64-musl", "win32-arm64", "win32-x64"].map((p) => `${SDK}-${p}`);
const host = `${SDK}-linux-x64`;
const ok = { host, supported, devOnly, bytes: 400e6, budgetBytes: 500e6 };

describe("the dev-only names", () => {
  it("are the build and test tools, and no production package", () => {
    for (const name of ["typescript", "vitest", "vite", "rolldown", "@rolldown/binding-darwin-arm64", "@typescript/typescript-darwin-arm64", "@types/node"]) expect([name, devOnly.has(name)]).toEqual([name, true]);
    for (const name of [SDK, "@anthropic-ai/sdk", "@modelcontextprotocol/sdk", "zod", "@auth/agent", `${SDK}-darwin-arm64`]) expect([name, devOnly.has(name)]).toEqual([name, false]);
  });
});

describe("the host's platform package", () => {
  it("is named as the SDK names it", () => {
    expect(hostPlatformPackage("darwin", "arm64", false)).toBe(`${SDK}-darwin-arm64`);
    expect(hostPlatformPackage("linux", "x64", false)).toBe(`${SDK}-linux-x64`);
    expect(hostPlatformPackage("linux", "arm64", true)).toBe(`${SDK}-linux-arm64-musl`);
    expect(hostPlatformPackage("win32", "x64", false)).toBe(`${SDK}-win32-x64`);
  });
});

describe("an installed tree", () => {
  const pkgs = (...names: string[]) => names.map((name) => ({ name }));

  it("passes with the production tree and only the host's binary", () => {
    expect(installProblems({ ...ok, packages: pkgs("podster", SDK, "zod", host) })).toEqual([]);
  });

  it("fails with another platform's binary, as 0.0.1-test.11 installed", () => {
    expect(installProblems({ ...ok, packages: pkgs("podster", SDK, host, `${SDK}-win32-x64`) })).toEqual([`installs other platforms' Claude Code binaries: ${SDK}-win32-x64`]);
  });

  it("fails without the host's binary, when the SDK ships one", () => {
    expect(installProblems({ ...ok, packages: pkgs("podster", SDK) })).toEqual([`doesn't install this host's Claude Code binary, ${host}`]);
    expect(installProblems({ ...ok, host: `${SDK}-freebsd-x64`, packages: pkgs("podster", SDK) })).toEqual([]);
  });

  it("fails with a dev tool", () => {
    expect(installProblems({ ...ok, packages: pkgs("podster", SDK, host, "typescript", "@rolldown/binding-linux-x64-gnu") })).toEqual(["installs dev-only packages: @rolldown/binding-linux-x64-gnu, typescript"]);
  });

  it("fails over the budget", () => {
    expect(installProblems({ ...ok, bytes: 3958e6, packages: pkgs("podster", SDK, host) })).toEqual(["installs 3958.0 MB, over the 500.0 MB budget"]);
  });
});

describe("a packed .tgz", () => {
  const files = ["package/package.json", "package/build/node/cli.js", "package/node_modules/zod/package.json", `package/node_modules/${SDK}/sdk.mjs`, "package/node_modules/@auth/agent/node_modules/jose/package.json"];

  it("names what it bundles, nested ones too", () => {
    expect([...bundledNames(files)].sort()).toEqual([SDK, "@auth/agent", "jose", "zod"]);
  });

  it("passes with the production bundle", () => {
    expect(tarballProblems({ paths: files, devOnly })).toEqual([]);
  });

  it("fails with a shipped shrinkwrap, a bundled binary or a bundled dev tool", () => {
    expect(tarballProblems({ paths: [...files, "package/npm-shrinkwrap.json"], devOnly })).toEqual(["ships npm-shrinkwrap.json, which npm installs whole, every platform and dev entry"]);
    expect(tarballProblems({ paths: [...files, `package/node_modules/${SDK}-linux-x64/claude`], devOnly })).toEqual([`bundles Claude Code binaries: ${SDK}-linux-x64`]);
    expect(tarballProblems({ paths: [...files, "package/node_modules/typescript/package.json"], devOnly })).toEqual(["bundles dev-only packages: typescript"]);
  });
});

describe("the installed-package walk", () => {
  let dir = "";
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("finds scoped and nested packages", () => {
    dir = mkdtempSync(join(tmpdir(), "install-shape-"));
    const put = (at: string, name: string) => {
      mkdirSync(join(dir, at), { recursive: true });
      writeFileSync(join(dir, at, "package.json"), JSON.stringify({ name, version: "1.0.0" }));
    };
    put("podster", "podster");
    put("podster/node_modules/@anthropic-ai/claude-agent-sdk", SDK);
    put(`@anthropic-ai/claude-agent-sdk-linux-x64`, `${SDK}-linux-x64`);
    expect(installedPackages(dir).map((p) => p.name).sort()).toEqual([`${SDK}-linux-x64`, SDK, "podster"].sort());
  });
});
