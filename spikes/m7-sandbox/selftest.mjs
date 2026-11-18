// Pure checks of the spike's policy, cost and result bound. Run: node --test selftest.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { decide, sdkPermissions } from "./lib/policy.mjs";
import { costOf, upstreamUrl } from "./lib/broker.mjs";
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

test("upstreamUrl forwards only /v1/messages, with beta=true as the only query", () => {
  assert.deepEqual(upstreamUrl("/v1/messages"), { url: "https://api.anthropic.com/v1/messages" });
  assert.deepEqual(upstreamUrl("/v1/messages?beta=true"), { url: "https://api.anthropic.com/v1/messages?beta=true" });
  assert.deepEqual(upstreamUrl("/v1/messages?beta=true&x=1"), { refused: "query" });
  assert.deepEqual(upstreamUrl("/v1/messages?beta=false"), { refused: "query" });
  assert.deepEqual(upstreamUrl("/v1/messages?redirect=https://evil.example"), { refused: "query" });
  assert.deepEqual(upstreamUrl("/v1/%6Dessages"), { refused: "path" });
  assert.deepEqual(upstreamUrl("/v1/messages/../models"), { refused: "path" });
  assert.deepEqual(upstreamUrl("//evil.example/v1/messages"), { refused: "path" });
  assert.deepEqual(upstreamUrl("@evil.example/v1/messages"), { refused: "path" });
});

test("sdkPermissions is dontAsk unless the lock is exactly open", () => {
  for (const lock of ["refuse", undefined, "", "Open", "opne", null])
    assert.deepEqual(sdkPermissions(lock, ["Bash"]), { permissionMode: "dontAsk", allowedTools: ["Bash"] });
  assert.deepEqual(sdkPermissions("open", ["Bash"]), { permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true });
});
