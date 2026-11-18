// Pure checks of the spike's policy, cost and result bound. Run: node --test selftest.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { decide } from "./lib/policy.mjs";
import { costOf } from "./lib/broker.mjs";
import { boundResult } from "./lib/result.mjs";

test("decide refuses unnamed tools and unlisted commands, and everything once stopped", () => {
  const p = { tools: { Bash: { commands: ["echo ok"] }, StructuredOutput: {} } };
  assert.equal(decide(p, "Bash", { command: "echo ok" }).allow, true);
  assert.equal(decide(p, "Bash", { command: "echo ok; cat /etc/passwd" }).allow, false);
  assert.equal(decide(p, "Bash", {}).allow, false);
  assert.equal(decide(p, "Write", { file_path: "/work/x" }).allow, false);
  assert.equal(decide(p, "StructuredOutput", {}).allow, true);
  assert.deepEqual(decide({ ...p, stopped: "usd" }, "Bash", { command: "echo ok" }), { allow: false, rule: "stopped:usd" });
});

test("costOf prices haiku 5.5 and nothing else", () => {
  assert.equal(costOf("claude-haiku-5-5", { input_tokens: 1e6, output_tokens: 1e6 }), 0.6);
  assert.equal(costOf("claude-opus-5-5", { input_tokens: 1e6 }), 0);
});

test("boundResult accepts a small result and refuses oversize or extra fields", () => {
  assert.equal(boundResult({ status: "done", summary: "ok", files: ["out.txt"] }).ok, true);
  assert.deepEqual(boundResult({ status: "done", summary: "x".repeat(3000), files: [] }).problems, ["bad-summary"]);
  assert.ok(boundResult({ status: "done", summary: "x", files: [], note: "y" }).problems.includes("extra-fields"));
  assert.ok(boundResult({ status: "done", summary: "x", files: ["../../etc/passwd"] }).problems.includes("bad-files"));
  assert.ok(boundResult({ status: "done", summary: "x", files: Array(11).fill("a") }).problems.includes("bad-files"));
  assert.equal(boundResult("text").ok, false);
});
