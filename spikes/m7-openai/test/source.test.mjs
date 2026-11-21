// Source and supply-chain checks (S-53, S-58): what the spike's code may import and name, exact pins, the lockfile,
// and that `--help` runs without reading the key.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { PINNED, versionRefusal } from "../lib/profile.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sources = [...readdirSync(join(root, "lib")).filter((f) => f.endsWith(".mjs")).map((f) => join("lib", f)), "spike.mjs"];
const read = (f) => readFileSync(join(root, f), "utf8");

/** Imports and names the spike's code must never use. */
const FORBIDDEN = [
  /from\s+["']@openai\/agents["']/, /import\(\s*["']@openai\/agents["']\s*\)/, /["']@openai\/agents-realtime/, /["']@openai\/agents-core\/sandbox/,
  /\bOpenAITracingExporter\b/, /\bsetDefaultOpenAITracingExporter\b/, /\bsetTracingExportApiKey\b/, /\bsetDefaultOpenAIKey\b/,
  /\bshellTool\b/, /\bapplyPatchTool\b/, /\bcomputerTool\b/, /\bwebSearchTool\b/, /\bfileSearchTool\b/, /\bcodeInterpreterTool\b/,
  /\bimageGenerationTool\b/, /\btoolSearchTool\b/, /\bprogrammaticToolCallingTool\b/, /\bhostedMcpTool\b/,
  /\bOpenAIResponsesWSModel\b/, /\bwithResponsesWebSocketSession\b/, /\bsetOpenAIResponsesTransport\b/, /\bOpenAIConversationsSession\b/,
];
const violations = (text) => FORBIDDEN.filter((re) => re.test(text)).map(String);

test("the scanner catches a planted umbrella import and trace exporter (control)", () => {
  assert.equal(violations('import { Agent } from "@openai/agents";\nsetDefaultOpenAITracingExporter();').length, 2);
  assert.deepEqual(violations('import { Agent } from "@openai/agents-core";'), []);
});

test("no spike source imports the umbrella, realtime, the trace exporter, a hosted or built-in tool, or the WebSocket transport", () => {
  for (const f of sources) assert.deepEqual(violations(read(f)), [], f);
});

test("only the profile names the upstream host and path", () => {
  for (const f of sources) {
    if (f === join("lib", "profile.mjs")) continue;
    assert.ok(!read(f).includes("/v1/responses"), `${f} names the path`);
    assert.ok(!/["'`]api\.openai\.com/.test(read(f)), `${f} names the host`);
  }
});

test("package.json pins exactly the three packages, and the installed versions match", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.deepEqual(pkg.dependencies, PINNED);
  const found = {};
  for (const name of Object.keys(PINNED)) found[name] = JSON.parse(readFileSync(join(root, "node_modules", name, "package.json"), "utf8")).version;
  assert.equal(versionRefusal(found), null);
  assert.equal(versionRefusal({ ...found, openai: "7.62.1" }), "version:openai");
});

test("the lockfile matches the pins, has sha512 integrity for every package, no install scripts and no realtime package", () => {
  const lock = JSON.parse(read("package-lock.json"));
  const pkgs = Object.entries(lock.packages).filter(([k]) => k !== "");
  for (const [name, version] of Object.entries(PINNED)) assert.equal(lock.packages[`node_modules/${name}`].version, version, name);
  for (const [k, v] of pkgs) {
    assert.match(v.integrity ?? "", /^sha512-/, k);
    assert.notEqual(v.hasInstallScript, true, k);
    assert.ok(!k.includes("agents-realtime"), k);
    assert.match(v.resolved ?? "", /^https:\/\/registry\.npmjs\.org\//, k);
  }
  assert.ok(!pkgs.some(([k]) => k === "node_modules/@openai/agents"), "umbrella absent");
});

test("spike.mjs --help prints the caps and exits without reading the key", () => {
  const r = spawnSync(process.execPath, [join(root, "spike.mjs"), "--help"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, M7O_KEY_FILE: join(root, "no-such-key-file") },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /0\.20 USD a run, 2\.00 USD a day/);
  assert.match(r.stdout, /gpt-6-luna only/);
});

test("spike.mjs refuses an unknown scenario before any start check or key read", () => {
  const r = spawnSync(process.execPath, [join(root, "spike.mjs"), "nope"], { encoding: "utf8", env: { PATH: process.env.PATH, M7O_KEY_FILE: join(root, "no-such-key-file") } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown scenario nope/);
});
