// Spike plan step 1: the real Agents SDK loop against the broker and a fake upstream, with no network at all.
// The loop, the decision point, StructuredOutput, the turn cap, cancellation, tracing off and zero sockets.
import test from "node:test";
import assert from "node:assert/strict";
import { addTraceProcessor } from "@openai/agents-core";
import { runTask, makeBrokerFetch, tracingState } from "../lib/driver.mjs";
import { RunBroker } from "../lib/broker.mjs";
import { providerTransport } from "../lib/transport.mjs";
import { OPENAI_PROFILE } from "../lib/profile.mjs";
import { decide, REFUSAL_TEXT } from "../lib/policy.mjs";
import { startSocketRecorder } from "../lib/sockets.mjs";
import { fakeUpstream, functionCall, message, TEST_KEY } from "./fake-upstream.mjs";

const CAPS = { spend_micro_usd: 200_000, turns: 20, output_tokens: 60_000, max_tokens: 4_096 };

function harness(script, { caps = CAPS, policy = { tools: ["shell"], commands: ["echo ok"], writes: false } } = {}) {
  const up = fakeUpstream(script);
  const transport = providerTransport({ profile: OPENAI_PROFILE, key: TEST_KEY, fetchImpl: up.fetchImpl });
  const controller = new AbortController();
  const broker = new RunBroker({ profile: OPENAI_PROFILE, caps, transport, onStop: (k) => controller.abort(new Error(k)) });
  controller.signal.addEventListener("abort", () => broker.cancel(), { once: true });
  const ran = [];
  const session = {
    allowed_tools: policy.tools,
    check: ({ name, input }) => decide({ ...policy, stopped: broker.state.stopped }, name, input),
    tool: async (call) => {
      ran.push(call.name);
      return "ok\n";
    },
  };
  const run = (task = "synthetic task", limits = { turns: caps.turns, max_tokens: caps.max_tokens }) =>
    runTask({ broker, profile: OPENAI_PROFILE, session, task, limits, signal: controller.signal });
  return { up, transport, broker, controller, ran, run };
}

const RESULT = { status: "done", summary: "synthetic", files: [] };

test("one allowed tool call, then StructuredOutput: decided, run, recorded; no socket opened and no trace emitted", async () => {
  const spy = { starts: 0, onTraceStart: async () => spy.starts++, onTraceEnd: async () => {}, onSpanStart: async () => spy.starts++, onSpanEnd: async () => {}, shutdown: async () => {}, forceFlush: async () => {} };
  addTraceProcessor(spy); // registered before the driver locks the SDK down: it must receive nothing
  const h = harness([functionCall("shell", { command: "echo ok" }), functionCall("StructuredOutput", RESULT)]);
  const sockets = startSocketRecorder();
  const rec = await h.run();
  sockets.stop();

  assert.equal(rec.error, null);
  assert.deepEqual(rec.result, RESULT);
  assert.deepEqual(rec.decisions.map((d) => [d.name, d.allow, d.rule]), [["shell", true, "command_listed"], ["StructuredOutput", true, "result"]]);
  assert.equal(rec.executions, 1);
  assert.deepEqual(h.ran, ["shell"]);
  assert.equal(h.up.calls.length, 2);
  assert.equal(h.broker.state.requests, 2);

  // What the SDK sent, after the broker's rewrite.
  for (const c of h.up.calls) {
    assert.equal(c.auth, "test-key");
    assert.equal(c.body.store, false);
    assert.equal(c.body.max_output_tokens, 4096);
    assert.equal(c.body.parallel_tool_calls, false);
    assert.equal(c.body.truncation, "disabled");
    assert.deepEqual(c.body.include, ["reasoning.encrypted_content"]);
    assert.deepEqual(c.body.tools.map((t) => [t.type, t.name, t.strict]), [["function", "shell", true], ["function", "StructuredOutput", true]]);
    assert.equal(typeof c.body.instructions, "string");
  }
  assert.deepEqual(h.up.calls[1].body.input.map((i) => i.type ?? i.role), ["user", "function_call", "function_call_output"]);

  assert.deepEqual(sockets.sockets, []);
  assert.deepEqual(sockets.fetchConnects, []);
  assert.equal(spy.starts, 0);
  assert.deepEqual(tracingState(), { lockedDown: true, noopTrace: true });
});

test("a call Runner refuses is not run; the model gets the fixed refusal text", async () => {
  const h = harness([functionCall("shell", { command: "curl -s https://example.com" }), functionCall("StructuredOutput", RESULT)]);
  const rec = await h.run();
  assert.equal(rec.error, null);
  assert.deepEqual(rec.decisions[0], { seq: 1, name: "shell", allow: false, rule: "command_not_listed" });
  assert.equal(rec.executions, 0);
  assert.deepEqual(h.ran, []);
  const out = h.up.calls[1].body.input.find((i) => i.type === "function_call_output");
  assert.equal(out.output, REFUSAL_TEXT);
});

test("a tool the run doesn't allow is never offered, and a call to it can't run", async () => {
  const h = harness([functionCall("write_file", { path: "x", content: "y" }), functionCall("StructuredOutput", RESULT)]);
  const rec = await h.run();
  assert.deepEqual(h.up.calls[0].body.tools.map((t) => t.name), ["shell", "StructuredOutput"]);
  assert.deepEqual(h.ran, []);
  // The SDK answers an unknown tool itself; either way nothing ran and no decision allowed it.
  assert.ok(rec.decisions.every((d) => d.name !== "write_file" || d.allow === false));
});

test("the SDK's own turn cap is a second lock behind the broker's", async () => {
  const loop = Array.from({ length: 10 }, () => functionCall("shell", { command: "echo ok" }));
  const h = harness(loop);
  const rec = await h.run("synthetic task", { turns: 3, max_tokens: 4096 });
  assert.equal(rec.result, null);
  assert.ok(rec.error, "the run fails");
  assert.equal(h.up.calls.length, 3);
});

test("the broker's turn cap stops the run, and nothing runs after the stop", async () => {
  const loop = Array.from({ length: 10 }, () => functionCall("shell", { command: "echo ok" }));
  const h = harness(loop, { caps: { ...CAPS, turns: 2 } });
  const rec = await h.run("synthetic task", { turns: 10, max_tokens: 4096 });
  assert.equal(rec.result, null);
  assert.ok(rec.error);
  assert.equal(h.transport.sent, 2);
  assert.equal(h.broker.state.stopped, "turns_exhausted");
  assert.ok(rec.fetch_refusals.includes("turns_exhausted"));
  assert.ok(h.ran.length <= 2);
});

test("a spend cap below one request's worst case fails the run before anything is sent", async () => {
  const h = harness([message("never")], { caps: { ...CAPS, spend_micro_usd: 50 } });
  const rec = await h.run();
  assert.ok(rec.error);
  assert.deepEqual(rec.fetch_refusals, ["spend_cap"]);
  assert.equal(h.transport.sent, 0);
});

test("cancelling mid-request cuts it, charges its worst case, and ends the run", async () => {
  const h = harness([{ hang: true }]);
  const p = h.run();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(h.broker.inFlight, 1);
  h.controller.abort(new Error("cancelled"));
  const rec = await p;
  assert.ok(rec.error);
  assert.equal(rec.result, null);
  assert.equal(h.broker.state.stopped, "cancelled");
  assert.equal(h.broker.inFlight, 0);
  assert.equal(h.broker.state.records[0].charged_worst, true);
  assert.equal(h.broker.state.reserved_micro_usd, 0);
});

test("brokerFetch takes only POST to the profile's one URL", async () => {
  const seen = [];
  const fakeBroker = { model: async (r) => (seen.push(r), new Response("{}")) };
  const f = makeBrokerFetch(fakeBroker, OPENAI_PROFILE);
  const body = JSON.stringify({});
  await f("https://api.openai.com/v1/responses", { method: "POST", body });
  assert.deepEqual(seen.map((r) => [r.method, r.path, r.query]), [["POST", "/v1/responses", ""]]);
  for (const [url, init] of [
    ["https://api.openai.com/v1/responses", { method: "GET" }],
    ["https://api.openai.com/v1/responses?x=1", { method: "POST", body }],
    ["https://api.openai.com/v1/responses/compact", { method: "POST", body }],
    ["https://api.openai.com/v1/traces/ingest", { method: "POST", body }],
    ["https://api.openai.com/v1/conversations", { method: "POST", body }],
    ["https://evil.example/v1/responses", { method: "POST", body }],
    ["wss://api.openai.com/v1/responses", { method: "POST", body }],
  ]) {
    await assert.rejects(f(url, init), (err) => err.code === "model_request_refused", url);
  }
  await assert.rejects(f("https://api.openai.com/v1/responses", { method: "POST", body: { not: "bytes" } }), /body/);
  assert.equal(seen.length, 1);
});

test("control: the spy processor shape does receive a trace when tracing is on, so the zero above means something", async () => {
  const { setTracingDisabled, setTraceProcessors, getGlobalTraceProvider } = await import("@openai/agents-core");
  const { lockDownSdk } = await import("../lib/driver.mjs");
  const spy = { starts: 0, onTraceStart: async () => spy.starts++, onTraceEnd: async () => {}, onSpanStart: async () => {}, onSpanEnd: async () => {}, shutdown: async () => {}, forceFlush: async () => {} };
  try {
    setTraceProcessors([spy]);
    setTracingDisabled(false);
    const trace = getGlobalTraceProvider().createTrace({ name: "control" });
    await trace.start();
    await trace.end();
    assert.equal(spy.starts, 1);
  } finally {
    lockDownSdk();
  }
  assert.deepEqual(tracingState(), { lockedDown: true, noopTrace: true });
});
