// The broker against a fake upstream: what is forwarded, what is refused before sending, caps, the worst-case
// reservation, settling from usage (S-55, S-56), and cancellation.
import test from "node:test";
import assert from "node:assert/strict";
import { RunBroker } from "../lib/broker.mjs";
import { providerTransport } from "../lib/transport.mjs";
import { OPENAI_PROFILE, OPENAI_MODEL } from "../lib/profile.mjs";
import { worstCaseOf, costOf, readUsage, checkRequest } from "../lib/dialect.mjs";
import { fakeUpstream, TEST_KEY, message, usage, sse } from "./fake-upstream.mjs";

const CAPS = { spend_micro_usd: 200_000, turns: 20, output_tokens: 60_000, max_tokens: 4_096 };
const PRICE = OPENAI_PROFILE.prices[OPENAI_MODEL];

function setup(script, caps = CAPS) {
  const up = fakeUpstream(script);
  const transport = providerTransport({ profile: OPENAI_PROFILE, key: TEST_KEY, fetchImpl: up.fetchImpl });
  const stops = [];
  const broker = new RunBroker({ profile: OPENAI_PROFILE, caps, transport, onStop: (k) => stops.push(k) });
  return { up, transport, broker, stops };
}

const body = (extra = {}) => new TextEncoder().encode(JSON.stringify({ model: OPENAI_MODEL, input: "synthetic task", stream: false, ...extra }));
const req = (extra, over = {}) => ({ method: "POST", path: "/v1/responses", query: "", body: body(extra), ...over });

test("forwards only the checked body, to the one URL, with the key added by the transport and no redirect", async () => {
  const { up, broker } = setup([message("ok", usage({ input: 10, output: 5 }))]);
  const res = await broker.model(req({ store: true, max_output_tokens: 99_999 }));
  assert.equal(res.status, 200);
  await res.json();
  assert.equal(up.calls.length, 1);
  const c = up.calls[0];
  assert.equal(c.url, "https://api.openai.com/v1/responses");
  assert.equal(c.method, "POST");
  assert.equal(c.auth, "test-key");
  assert.equal(c.redirect, "error");
  assert.deepEqual(c.headers.sort(), ["authorization", "content-type"]);
  assert.equal(c.body.store, false);
  assert.equal(c.body.max_output_tokens, 4096);
});

test("refusals happen before anything is sent", async () => {
  const { transport, broker } = setup([]);
  const cases = [
    [req({}, { method: "GET" }), "method"],
    [req({}, { path: "/v1/responses/compact" }), "path"],
    [req({}, { path: "/v1/chat/completions" }), "path"],
    [req({}, { query: "x=1" }), "query"],
    [req({ background: true }), "refused_key"],
    [req({ previous_response_id: "resp_1" }), "refused_key"],
    [req({ service_tier: "priority" }), "refused_key"],
    [req({ prompt_cache_retention: "24h" }), "refused_key"],
    [req({ tools: [{ type: "web_search" }] }), "tools"],
    [req({ model: "gpt-6.1-terra" }), "model"],
  ];
  for (const [r, reason] of cases) {
    await assert.rejects(broker.model(r), (err) => err.code === "model_request_refused" && err.reason === reason, reason);
  }
  assert.equal(transport.sent, 0);
  assert.equal(broker.state.requests, 0);
  assert.equal(broker.state.stopped, null);
});

test("a completed answer is charged from its usage; the bound and output are recorded", async () => {
  const u = usage({ input: 1200, output: 300, cached: 100, reasoning: 40 });
  const { broker } = setup([message("ok", u)]);
  const res = await broker.model(req({}));
  await res.text();
  const rec = broker.state.records[0];
  assert.equal(rec.terminal, "completed");
  assert.equal(rec.charged_worst, false);
  assert.equal(rec.charged_micro_usd, costOf(PRICE, readUsage(u).usage));
  assert.equal(broker.state.spent_micro_usd, rec.charged_micro_usd);
  assert.equal(broker.state.reserved_micro_usd, 0);
  assert.equal(broker.state.output_used, 340);
  assert.equal(rec.output_over_bound, false);
});

test("output above the bound is flagged; an incomplete answer is charged its worst case", async () => {
  const over = { ...message("long", usage({ output: 5000 })), status: "incomplete", incomplete_details: { reason: "max_output_tokens" } };
  const { broker } = setup([over]);
  await (await broker.model(req({ max_output_tokens: 100 }))).text();
  const rec = broker.state.records[0];
  assert.equal(rec.output_over_bound, true);
  assert.equal(rec.terminal, "incomplete");
  assert.equal(rec.incomplete_reason, "max_output_tokens");
  assert.equal(rec.charged_worst, true);
  assert.equal(rec.charged_micro_usd, rec.worst_micro_usd);
  assert.equal(rec.worst_micro_usd, worstCaseOf(PRICE, rec.body_bytes, 100));
});

test("missing usage fields, a non-2xx answer and 12-hour cache writes all count the worst case", async () => {
  const noWrite = message("x", usage());
  delete noWrite.usage.input_tokens_details.cache_write_tokens;
  const { broker, stops } = setup([noWrite, { httpStatus: 500, body: { error: {} } }, message("x", usage({ ttl12h: 10 }))]);
  await (await broker.model(req({}))).text();
  const r500 = await broker.model(req({}));
  assert.equal(r500.status, 500);
  await r500.text();
  await (await broker.model(req({}))).text();
  const [a, b, c] = broker.state.records;
  assert.deepEqual(a.missing_usage_fields, ["cache_write_tokens"]);
  for (const r of [a, b, c]) assert.equal(r.charged_worst, true);
  assert.deepEqual(stops, ["usage_unexpected"]);
  await assert.rejects(broker.model(req({})), (err) => err.reason === "stopped");
});

test("a streamed answer is charged from response.completed; a cut stream counts its worst case", async () => {
  const u = usage({ input: 50, output: 10 });
  const text = sse(message("streamed", u));
  const { broker } = setup([{ sse: text }, { sse: text, cutAt: 60 }]);
  const res = await broker.model(req({ stream: true }));
  assert.match(await res.text(), /response\.completed/);
  assert.equal(broker.state.records[0].charged_worst, false);
  assert.equal(broker.state.records[0].charged_micro_usd, costOf(PRICE, readUsage(u).usage));

  const cut = await broker.model(req({ stream: true }));
  await assert.rejects(cut.text());
  const rec = broker.state.records[1];
  assert.equal(rec.terminal, "cut");
  assert.equal(rec.charged_worst, true);
});

test("the turn cap stops the run on the request after the last allowed one", async () => {
  const { broker, stops, transport } = setup([message("1"), message("2"), message("3")], { ...CAPS, turns: 2 });
  await (await broker.model(req({}))).text();
  await (await broker.model(req({}))).text();
  await assert.rejects(broker.model(req({})), (err) => err.reason === "turns_exhausted" && err.hardStop);
  assert.deepEqual(stops, ["turns_exhausted"]);
  assert.equal(transport.sent, 2);
});

test("the reservation refuses a request whose worst case would pass the spend cap, so spend never passes it", async () => {
  const checked = checkRequest(body(), OPENAI_PROFILE, { maxOutputTokens: 4096 });
  const w = worstCaseOf(PRICE, checked.body.byteLength, 4096);
  const cap = Math.floor(w * 2.5);
  // Each answer costs a little under its worst case, so two fit and the third's worst case would pass the cap.
  const answers = Array.from({ length: 5 }, () => message("x", usage({ input: 4000, output: 4096 })));
  const { broker, stops, transport } = setup(answers, { ...CAPS, spend_micro_usd: cap });
  await (await broker.model(req({}))).text();
  await (await broker.model(req({}))).text();
  await assert.rejects(broker.model(req({})), (err) => err.reason === "spend_cap" && err.hardStop);
  assert.equal(transport.sent, 2);
  assert.ok(broker.state.spent_micro_usd <= cap);
  assert.deepEqual(stops, ["spend_cap"]);
});

test("a tight spend cap refuses the first request outright", async () => {
  const { broker, transport, stops } = setup([message("x")], { ...CAPS, spend_micro_usd: 100 });
  await assert.rejects(broker.model(req({})), (err) => err.reason === "spend_cap");
  assert.equal(transport.sent, 0);
  assert.deepEqual(stops, ["spend_cap"]);
});

test("the output-token cap bounds each request and stops the run when used up", async () => {
  const { broker, up, stops } = setup([message("a", usage({ output: 900 })), message("b", usage({ output: 100 }))], { ...CAPS, output_tokens: 1000 });
  await (await broker.model(req({}))).text();
  assert.equal(up.calls[0].body.max_output_tokens, 1000);
  await (await broker.model(req({}))).text();
  assert.equal(up.calls[1].body.max_output_tokens, 100);
  assert.deepEqual(stops, ["output_tokens_exhausted"]);
  await assert.rejects(broker.model(req({})), (err) => err.reason === "stopped");
});

test("cancel cuts a request in flight, charges its worst case, and refuses later ones", async () => {
  const { broker, stops, transport } = setup([{ hang: true }]);
  const p = broker.model(req({}));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(broker.inFlight, 1);
  broker.cancel();
  await assert.rejects(p);
  assert.equal(broker.inFlight, 0);
  assert.equal(broker.state.cut_in_flight, 1);
  assert.equal(broker.state.records[0].charged_worst, true);
  assert.deepEqual(stops, ["cancelled"]);
  await assert.rejects(broker.model(req({})), (err) => err.reason === "stopped");
  assert.equal(transport.sent, 1);
});

test("a caller's abort signal cuts its own request", async () => {
  const { broker } = setup([{ hang: true }]);
  const ac = new AbortController();
  const p = broker.model(req({}), ac.signal);
  await new Promise((r) => setTimeout(r, 10));
  ac.abort();
  await assert.rejects(p);
  assert.equal(broker.state.records[0].terminal, "error");
  assert.equal(broker.state.reserved_micro_usd, 0);
});

test("a profile with an auth, beta, organization or project header is refused", () => {
  for (const h of ["Authorization", "OpenAI-Beta", "OpenAI-Organization", "OpenAI-Project"]) {
    const profile = { ...OPENAI_PROFILE, headers: { ...OPENAI_PROFILE.headers, [h]: "x" } };
    assert.throws(() => new RunBroker({ profile, caps: CAPS, transport: {} }), /profile refused/);
  }
});
