// The body allowlist, the output bound, the worst case and the usage reading (S-55, S-56). Pure.
import test from "node:test";
import assert from "node:assert/strict";
import { checkRequest, REFUSED_KEYS, HOSTED_TOOL_TYPES, worstCaseOf, readUsage, costOf, SseUsageReader, readJsonAnswer, INPUT_MARGIN_TOKENS } from "../lib/dialect.mjs";
import { OPENAI_PROFILE, OPENAI_MODEL } from "../lib/profile.mjs";
import { usage, sse, message } from "./fake-upstream.mjs";

const enc = (o) => new TextEncoder().encode(typeof o === "string" ? o : JSON.stringify(o));
const dec = (b) => JSON.parse(new TextDecoder().decode(b));
const fn = { type: "function", name: "shell", description: "d", parameters: { type: "object" }, strict: true };
const base = { model: OPENAI_MODEL, instructions: "frame", input: [{ role: "user", content: "task" }], tools: [fn], stream: false };
const check = (extra, bound = 1000) => checkRequest(enc({ ...base, ...extra }), OPENAI_PROFILE, { maxOutputTokens: bound });

test("a plain request passes, with store forced false and the bound written in", () => {
  const r = check({ store: true });
  assert.equal(r.ok, true);
  const out = dec(r.body);
  assert.equal(out.store, false);
  assert.equal(out.max_output_tokens, 1000);
  assert.equal(r.max_output_tokens, 1000);
});

test("max_output_tokens is min(bound, asked), and a bad value is refused", () => {
  assert.equal(dec(check({ max_output_tokens: 50_000 }, 4096).body).max_output_tokens, 4096);
  assert.equal(dec(check({ max_output_tokens: 100 }, 4096).body).max_output_tokens, 100);
  assert.equal(dec(check({ max_output_tokens: null }, 4096).body).max_output_tokens, 4096);
  for (const v of [0, -1, 1.5, "9", true]) assert.equal(check({ max_output_tokens: v }).reason, "max_output_tokens", String(v));
  assert.equal(check({}, 0).reason, "output_bound");
});

test("a duplicate key can't slip past: what is forwarded is what was checked", () => {
  const raw = `{"model":"${OPENAI_MODEL}","input":"x","store":true,"store":true,"max_output_tokens":99999,"max_output_tokens":10}`;
  const r = checkRequest(enc(raw), OPENAI_PROFILE, { maxOutputTokens: 500 });
  assert.equal(r.ok, true);
  const text = new TextDecoder().decode(r.body);
  assert.equal(text.match(/"store"/g).length, 1);
  assert.equal(text.match(/"max_output_tokens"/g).length, 1);
  assert.equal(dec(r.body).store, false);
  assert.equal(dec(r.body).max_output_tokens, 10);
});

test("each key the design refuses is refused by name", () => {
  for (const key of REFUSED_KEYS) {
    const r = check({ [key]: key === "background" ? true : "x" });
    assert.deepEqual([r.ok, r.reason, r.detail], [false, "refused_key", key], key);
  }
});

test("an unknown key is refused by name", () => {
  assert.deepEqual([check({ extra_body: {} }).reason, check({ extra_body: {} }).detail], ["unknown_key", "extra_body"]);
  assert.equal(check({ __proto__x: 1 }).reason, "unknown_key");
});

test("every hosted tool type is refused, and a function tool may carry only its five fields", () => {
  for (const type of HOSTED_TOOL_TYPES) {
    const r = check({ tools: [fn, { type }] });
    assert.deepEqual([r.reason, r.detail], ["tools", `tool_type:${type}`], type);
  }
  assert.equal(check({ tools: [{ ...fn, defer_loading: true }] }).detail, "tool_field:defer_loading");
  assert.equal(check({ tools: [{ ...fn, name: "a b" }] }).detail, "tool_name");
});

test("a non-Standard service tier, a long cache retention, background and server-side state can't pass", () => {
  for (const extra of [{ service_tier: "priority" }, { service_tier: "flex" }, { prompt_cache_retention: "24h" }, { background: true }, { previous_response_id: "resp_1" }, { conversation: { id: "c" } }]) {
    assert.equal(check(extra).ok, false, JSON.stringify(extra));
  }
});

test("the model must have a price", () => {
  assert.equal(check({ model: "gpt-6.1-terra" }).reason, "model");
  assert.equal(check({ model: "toString" }).reason, "model");
});

test("input: only user and assistant messages of text; tool calls by known name; reasoning items", () => {
  const ok = (input) => check({ input }).ok;
  const why = (input) => check({ input }).detail;
  assert.equal(ok("plain string"), true);
  assert.equal(ok([{ role: "user", content: [{ type: "input_text", text: "t" }] }]), true);
  assert.equal(ok([{ type: "message", role: "assistant", id: "m", status: "completed", content: [{ type: "output_text", text: "t", annotations: [] }] }]), true);
  assert.equal(ok([{ type: "function_call", id: "fc", call_id: "c", name: "shell", arguments: "{}", status: "completed" }]), true);
  assert.equal(ok([{ type: "function_call_output", call_id: "c", output: "out", status: "completed" }]), true);
  assert.equal(ok([{ type: "reasoning", id: "r", summary: [], encrypted_content: "opaque" }]), true);

  assert.equal(why([{ role: "system", content: "x" }]), "input_role:system");
  assert.equal(why([{ role: "developer", content: "x" }]), "input_role:developer");
  assert.equal(why([{ role: "user", content: [{ type: "input_image", image_url: "https://x" }] }]), "input_content_part:input_image");
  assert.equal(why([{ role: "user", content: [{ type: "input_file", file_id: "f" }] }]), "input_content_part:input_file");
  assert.equal(why([{ role: "user", content: [{ type: "input_audio" }] }]), "input_content_part:input_audio");
  assert.equal(why([{ type: "item_reference", id: "x" }]), "input_type:item_reference");
  assert.equal(why([{ type: "function_call", call_id: "c", name: "web_search", arguments: "{}" }]), "input_function_name");
  assert.equal(why([{ type: "function_call_output", call_id: "c", output: [{ type: "input_image" }] }]), "input_function_output");
  assert.equal(why([{ role: "user", content: "x", extra: 1 }]), "input_field:message.extra");
  assert.equal(why([{ type: "reasoning", id: "r", summary: [], content: [{ type: "reasoning_text", text: "x" }] }]), "input_reasoning_content");
});

test("tool_choice, include, reasoning, text, truncation", () => {
  for (const c of ["auto", "required", "none", { type: "function", name: "shell" }]) assert.equal(check({ tool_choice: c }).ok, true);
  assert.equal(check({ tool_choice: { type: "function", name: "other" } }).ok, false);
  assert.equal(check({ tool_choice: { type: "web_search" } }).ok, false);
  assert.equal(check({ include: [] }).ok, true);
  assert.equal(check({ include: ["reasoning.encrypted_content"] }).ok, true);
  assert.equal(check({ include: ["file_search_call.results"] }).reason, "include");
  assert.equal(check({ reasoning: { effort: "low" } }).ok, true);
  assert.equal(check({ reasoning: { effort: "xhigh" } }).reason, "reasoning_effort");
  assert.equal(check({ reasoning: { summary: "detailed" } }).reason, "reasoning_summary");
  assert.equal(check({ reasoning: { effort: "low", mode: "x" } }).reason, "reasoning");
  assert.equal(check({ text: { format: { type: "json_schema", name: "r", schema: {} } } }).ok, true);
  assert.equal(check({ text: { format: { type: "grammar" } } }).reason, "text_format");
  assert.equal(check({ truncation: "disabled" }).ok, true);
  assert.equal(check({ truncation: "auto" }).reason, "truncation");
});

test("bodies that aren't one JSON object are refused", () => {
  assert.equal(checkRequest(enc("not json"), OPENAI_PROFILE, { maxOutputTokens: 1 }).reason, "body_json");
  assert.equal(checkRequest(enc("[1]"), OPENAI_PROFILE, { maxOutputTokens: 1 }).reason, "body_json");
  assert.equal(checkRequest(new Uint8Array([0xff, 0xfe]), OPENAI_PROFILE, { maxOutputTokens: 1 }).reason, "body_json");
  assert.equal(checkRequest("string", OPENAI_PROFILE, { maxOutputTokens: 1 }).reason, "body");
});

const PRICE = OPENAI_PROFILE.prices[OPENAI_MODEL];

test("worst case: bytes plus margin at the dearest input rate, plus the whole bound at the output rate, tier by size", () => {
  // Short tier: dearest input rate is the cache write, 125,000 micro-USD per million.
  assert.equal(worstCaseOf(PRICE, 10_000, 1_000), Math.ceil(((10_000 + INPUT_MARGIN_TOKENS) * 125_000 + 1_000 * 500_000) / 1e6));
  // Above 272K input: the long tier's rates.
  assert.equal(worstCaseOf(PRICE, 300_000, 1_000), Math.ceil(((300_000 + INPUT_MARGIN_TOKENS) * 250_000 + 1_000 * 750_000) / 1e6));
});

test("usage is priced on the overcounting reading: cached, cache-write and reasoning tokens on top", () => {
  const read = readUsage(usage({ input: 1_000_000, output: 1_000_000, cached: 1_000_000, cacheWrite: 1_000_000, reasoning: 1_000_000 }));
  assert.deepEqual(read.missing, []);
  // Long tier, since the input measure (3M) is above 272K.
  assert.equal(costOf(PRICE, read.usage), 200_000 + 20_000 + 250_000 + 2 * 750_000);
  const small = readUsage(usage({ input: 1000, output: 100, cached: 500, cacheWrite: 0, reasoning: 50 }));
  assert.equal(costOf(PRICE, small.usage), Math.ceil((1000 * 100_000 + 500 * 10_000 + 150 * 500_000) / 1e6));
});

test("a usage object missing a field is flagged, and 12-hour cache writes are unexpected", () => {
  const u = usage();
  delete u.input_tokens_details.cache_write_tokens;
  assert.deepEqual(readUsage(u).missing, ["cache_write_tokens"]);
  assert.deepEqual(readUsage({ input_tokens: 1 }).missing.sort(), ["cache_write_tokens", "cached_tokens", "output_tokens", "reasoning_tokens", "total_tokens"]);
  assert.equal(readUsage(null), null);
  assert.equal(readUsage(usage({ ttl12h: 5 })).unexpected, true);
  assert.equal(readUsage(usage({ ttl12h: 0 })).unexpected, false);
  assert.ok(readUsage({ ...usage(), output_tokens: -1 }).missing.includes("output_tokens"));
});

test("the stream reader takes usage only from response.completed, and sees cut and failed streams", () => {
  const resp = message("hi", usage({ input: 7, output: 3 }));
  const whole = new TextEncoder().encode(sse(resp));
  const r = new SseUsageReader();
  // Fed in small pieces, as a network would.
  for (let i = 0; i < whole.length; i += 7) r.push(whole.slice(i, i + 7));
  assert.equal(r.terminal, "completed");
  assert.equal(r.usage.input_tokens, 7);

  const cut = new SseUsageReader();
  cut.push(whole.slice(0, whole.length - 40));
  assert.equal(cut.terminal, null);

  for (const [ev, kind] of [["response.failed", "failed"], ["response.incomplete", "incomplete"]]) {
    const x = new SseUsageReader();
    x.push(new TextEncoder().encode(sse(resp, ev)));
    assert.equal(x.terminal, kind);
  }
  const e = new SseUsageReader();
  e.push(new TextEncoder().encode('event: error\ndata: {"type":"error","code":"x"}\n\n'));
  assert.equal(e.terminal, "error");
});

test("a non-streamed answer's status decides its terminal state", () => {
  assert.equal(readJsonAnswer(JSON.stringify(message("x"))).terminal, "completed");
  assert.deepEqual(readJsonAnswer(JSON.stringify({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: usage() })).incomplete_reason, "max_output_tokens");
  assert.equal(readJsonAnswer("{").terminal, "error");
});
