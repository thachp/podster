// What an install of Runner's package may hold (scripts/install-shape.mjs). The real install is checked by
// scripts/install-check.mjs, in CI's runner job and the pre-release workflow; these are its rules on made-up trees.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bundledNames, devOnlyNames, installedPackages, installProblems, tarballProblems, type Lock } from "../scripts/install-shape.mjs";

const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8")) as Lock;
const devOnly = devOnlyNames(lock);
const SDK = "@anthropic-ai/claude-agent-sdk";
const ok = { devOnly, bytes: 43e6, budgetBytes: 60e6 };

describe("the dev-only names", () => {
  it("are the build and test tools, and no production package", () => {
    for (const name of ["typescript", "vitest", "vite", "rolldown", "@rolldown/binding-darwin-arm64", "@typescript/typescript-darwin-arm64", "@types/node"]) expect([name, devOnly.has(name)]).toEqual([name, true]);
    for (const name of [SDK, "@anthropic-ai/sdk", "@modelcontextprotocol/sdk", "zod", "@auth/agent", `${SDK}-darwin-arm64`]) expect([name, devOnly.has(name)]).toEqual([name, false]);
  });
});

describe("an installed tree", () => {
  const pkgs = (...names: string[]) => names.map((name) => ({ name }));

  it("passes with the production tree and no Claude Code binary", () => {
    expect(installProblems({ ...ok, packages: pkgs("podster", SDK, "zod") })).toEqual([]);
  });

  it("fails with any Claude Code binary, the host's included, as 0.0.1-test.11 installed all eight", () => {
    expect(installProblems({ ...ok, packages: pkgs("podster", SDK, `${SDK}-linux-x64`, `${SDK}-win32-x64`) })).toEqual([`installs Claude Code binaries: ${SDK}-linux-x64, ${SDK}-win32-x64`]);
  });

  it("fails with a dev tool", () => {
    expect(installProblems({ ...ok, packages: pkgs("podster", SDK, "typescript", "@rolldown/binding-linux-x64-gnu") })).toEqual(["installs dev-only packages: @rolldown/binding-linux-x64-gnu, typescript"]);
  });

  it("fails over the budget", () => {
    expect(installProblems({ ...ok, bytes: 397e6, packages: pkgs("podster", SDK) })).toEqual(["installs 397.0 MB, over the 60.0 MB budget"]);
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
