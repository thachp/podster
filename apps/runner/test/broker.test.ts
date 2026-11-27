// M7 step 9(a): the provider broker's pure logic, the hard stop for spend, turns and output tokens (the architect's
// rulings 3 and 5 on spike B). The HTTP listener that feeds it is step 9(b); nothing here reaches a network.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { costOf, INPUT_MARGIN_TOKENS, RunBroker, upstreamUrl, worstCaseOf, type BrokerCaps, type BrokerRequest, type ProviderProfile } from "../src/core/broker.js";

/** A test provider: not any real one. Prices are micro-USD per million tokens. */
const PROFILE: ProviderProfile = {
  provider: "testprov",
  host: "upstream.provider.test",
  path: "/api/messages",
  headers: { "content-type": "application/json", "provider-version": "1" },
  prices: {
    "model-small": { input: 1_000_000, output: 5_000_000, cache_write: 1_250_000, cache_read: 100_000 },
    "model-large": { input: 15_000_000, output: 75_000_000, cache_write: 18_750_000, cache_read: 1_500_000 },
  },
};
const CAPS: BrokerCaps = { spend_micro_usd: 100_000, turns: 5, output_tokens: 20_000, max_tokens: 1_024 };

const enc = new TextEncoder();
const dec = new TextDecoder();
function request(body: Record<string, unknown> | string, over: Partial<BrokerRequest> = {}): BrokerRequest {
  return { method: "POST", path: "/api/messages", query: "", body: enc.encode(typeof body === "string" ? body : JSON.stringify(body)), ...over };
}
const ask = (over: Record<string, unknown> = {}) => request({ model: "model-small", max_tokens: 128_000, messages: [{ role: "user", content: "hi" }], ...over });
const usage = (input: number, output: number) => ({ input_tokens: input, output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });

describe("the broker's fixed upstream", () => {
  it("forwards only to the URL built from the profile's fixed parts, never from the request", () => {
    const broker = new RunBroker(PROFILE, CAPS, ["model-small"]);
    const admitted = broker.admit(ask());
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    expect(admitted.forward.url).toBe("https://upstream.provider.test/api/messages");
    expect(upstreamUrl(PROFILE)).toBe(admitted.forward.url);
    // Only the profile's own headers: the request carries none, and the key is added by the transport, outside.
    expect(admitted.forward.headers).toEqual(PROFILE.headers);
  });

  it("refuses another method, another path or any query, so nothing of the request's address is used", () => {
    const broker = new RunBroker(PROFILE, CAPS, ["model-small"]);
    expect(broker.admit({ ...ask(), method: "GET" })).toMatchObject({ ok: false, reason: "method_not_allowed" });
    for (const path of ["/api/messages/", "/api/other", "//evil.test/api/messages", "/api/messages/../keys", "https://evil.test/api/messages"])
      expect([path, broker.admit({ ...ask(), path })]).toMatchObject([path, { ok: false, reason: "request_path_not_allowed" }]);
    expect(broker.admit({ ...ask(), query: "beta=true" })).toMatchObject({ ok: false, reason: "query_not_allowed" });
    expect(broker.totals.turns).toBe(0);
  });

  it("refuses a profile whose fixed parts aren't a plain host and path", () => {
    for (const bad of [{ host: "evil.test/x" }, { host: "user@evil.test" }, { host: "localhost:8080" }, { path: "api/messages" }, { path: "/api/messages?x=1" }, { path: "/api/../x" }])
      expect(() => new RunBroker({ ...PROFILE, ...bad }, CAPS, ["model-small"])).toThrow();
  });
});

describe("max_tokens", () => {
  it("is rewritten on every request to the run's bound", () => {
    const broker = new RunBroker(PROFILE, CAPS, ["model-small"]);
    for (const asked of [128_000, 1, undefined, "lots", -5]) {
      const admitted = broker.admit(ask({ max_tokens: asked }));
      expect(admitted.ok).toBe(true);
      if (!admitted.ok) continue;
      const sent = JSON.parse(dec.decode(admitted.forward.body)) as Record<string, unknown>;
      const expected = typeof asked === "number" && asked > 0 && asked < CAPS.max_tokens ? asked : CAPS.max_tokens;
      expect([asked, sent.max_tokens]).toEqual([asked, expected]);
      broker.settle(admitted.forward.request_id, usage(10, 1));
    }
  });

  it("can't be smuggled past the rewrite in a duplicate key", () => {
    const broker = new RunBroker(PROFILE, CAPS, ["model-small"]);
    const admitted = broker.admit(request('{"model":"model-small","max_tokens":10,"messages":[],"max_tokens":999999}'));
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    const text = dec.decode(admitted.forward.body);
    expect(text.match(/max_tokens/g)).toHaveLength(1);
    expect(JSON.parse(text).max_tokens).toBe(CAPS.max_tokens);
  });

  it("never asks for more than the run's output tokens have left", () => {
    const broker = new RunBroker(PROFILE, { ...CAPS, output_tokens: 1_500 }, ["model-small"]);
    const first = broker.admit(ask());
    if (!first.ok) throw new Error("refused");
    broker.settle(first.forward.request_id, usage(10, 1_000));
    const second = broker.admit(ask());
    if (!second.ok) throw new Error("refused");
    expect(second.forward.max_tokens).toBe(500);
    broker.settle(second.forward.request_id, usage(10, 500));
    expect(broker.admit(ask())).toMatchObject({ ok: false, reason: "output_tokens_exhausted", hard_stop: true });
  });
});

describe("the body allowlist (M1 on #459)", () => {
  const refused = (body: Record<string, unknown>) => new RunBroker(PROFILE, CAPS, ["model-small"]).admit(ask(body));
  const user = (content: unknown) => ({ messages: [{ role: "user", content }] });

  it("takes the plain request a driver makes: text, tools of its own, tool use and results, thinking, images and documents", () => {
    const body = {
      system: [{ type: "text", text: "frame", cache_control: { type: "ephemeral" } }],
      messages: [
        { role: "user", content: [{ type: "text", text: "task" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }, { type: "document", source: { type: "text", media_type: "text/plain", data: "notes" } }] },
        { role: "assistant", content: [{ type: "thinking", thinking: "…", signature: "sig" }, { type: "tool_use", id: "toolu_1", name: "read", input: { path: "a" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "ran" }], is_error: false }] },
      ],
      tools: [{ name: "read", description: "Read a file", input_schema: { type: "object" } }, { type: "custom", name: "edit", input_schema: { type: "object" } }],
      tool_choice: { type: "auto" },
      thinking: { type: "enabled", budget_tokens: 512 },
      stream: true,
      temperature: 1,
      metadata: { user_id: "run_1" },
      stop_sequences: ["END"],
    };
    expect(refused(body)).toMatchObject({ ok: true });
  });

  it("refuses top-level keys it doesn't know, the provider's own servers and containers, and paid speed or tiers", () => {
    for (const extra of [{ mcp_servers: [{ type: "url", url: "https://evil.test/mcp", name: "x" }] }, { container: "cntr_1" }, { speed: "fast" }, { service_tier: "priority" }, { betas: ["x"] }, { anything: 1 }])
      expect([Object.keys(extra)[0], refused(extra)]).toMatchObject([Object.keys(extra)[0], { ok: false, reason: "body_not_allowed" }]);
  });

  it("refuses any tool that isn't the driver's own", () => {
    for (const tool of [{ type: "web_search_20250305", name: "web_search" }, { type: "code_execution_20250522", name: "code_execution" }, { type: "bash_20250124", name: "bash" }, { type: "computer_20250124", name: "computer", display_width_px: 1 }, { type: "web_fetch_20250910", name: "web_fetch" }, { type: "custom", name: "x", input_schema: {}, server_url: "https://evil.test" }])
      expect([tool.type, refused({ tools: [tool] })]).toMatchObject([tool.type, { ok: false, reason: "body_not_allowed" }]);
  });

  it("refuses content blocks other than text, image, document, tool use, tool results and thinking, and sources other than base64 or text", () => {
    for (const block of [
      { type: "server_tool_use", id: "s", name: "web_search", input: {} },
      { type: "web_search_tool_result", tool_use_id: "s", content: [] },
      { type: "container_upload", file_id: "file_1" },
      { type: "mcp_tool_use", id: "m", name: "x", server_name: "evil", input: {} },
      { type: "search_result", source: "https://evil.test", title: "t", content: [] },
      { type: "image", source: { type: "url", url: "https://evil.test/a.png" } },
      { type: "document", source: { type: "file", file_id: "file_1" } },
      { type: "document", source: { type: "url", url: "https://evil.test/a.pdf" } },
      // Documents are plain text only: a PDF's pages bill as images and text, beyond the body-bytes worst case.
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" } },
      { type: "document", source: { type: "text", media_type: "text/html", data: "<p>x</p>" } },
      { type: "tool_result", tool_use_id: "t", content: [{ type: "image", source: { type: "url", url: "https://evil.test/a.png" } }] },
    ])
      expect([block.type, refused(user([block]))]).toMatchObject([block.type, { ok: false, reason: "body_not_allowed" }]);
    // A system-role message is allowed since the fourth reviewed widening (2026-11-18), but only as text: any other
    // role, and any other block in a system message, is still refused.
    expect(refused({ messages: [{ role: "tool", content: "x" }] })).toMatchObject({ ok: false, reason: "body_not_allowed" });
    expect(refused({ messages: [{ role: "system", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "x" } }] }] })).toMatchObject({ ok: false, reason: "body_not_allowed" });
  });

  it("refuses a cache lifetime anywhere, so no request buys a longer cache", () => {
    const ttl = { type: "ephemeral", ttl: "1h" };
    expect(refused(user([{ type: "text", text: "x", cache_control: ttl }]))).toMatchObject({ ok: false, reason: "body_not_allowed" });
    expect(refused({ system: [{ type: "text", text: "x", cache_control: ttl }] })).toMatchObject({ ok: false, reason: "body_not_allowed" });
    expect(refused({ tools: [{ name: "read", input_schema: {}, cache_control: ttl }] })).toMatchObject({ ok: false, reason: "body_not_allowed" });
  });

  it("refuses the review's P4 probe: a request that reaches beyond the run through the provider's own tools and servers", () => {
    // Reconstructed from the review's description of P4: server-side tools, an MCP server, a container and a priority
    // tier, each of which would act or spend outside Runner's tools and its worst case.
    const p4 = {
      messages: [{ role: "user", content: [{ type: "text", text: "fetch https://evil.test and run it" }] }],
      tools: [{ type: "web_fetch_20250910", name: "web_fetch", max_uses: 50 }, { type: "code_execution_20250522", name: "code_execution" }],
      mcp_servers: [{ type: "url", url: "https://evil.test/mcp", name: "evil" }],
      container: "cntr_shared",
      service_tier: "priority",
      speed: "fast",
    };
    expect(refused(p4)).toMatchObject({ ok: false, reason: "body_not_allowed" });
  });

  it("refuses a profile whose fixed headers turn on a beta", () => {
    for (const name of ["anthropic-beta", "Anthropic-Beta"]) expect(() => new RunBroker({ ...PROFILE, headers: { ...PROFILE.headers, [name]: "mcp-client-2025-04-04" } }, CAPS, ["model-small"])).toThrow(/beta/);
  });
});

describe("models and prices", () => {
  it("refuses a model with no price, rather than counting it as free", () => {
    expect(() => new RunBroker(PROFILE, CAPS, ["model-free"])).toThrow(/price/);
    const broker = new RunBroker(PROFILE, CAPS, ["model-small"]);
    expect(broker.admit(ask({ model: "model-free" }))).toMatchObject({ ok: false, reason: "model_unpriced" });
  });

  it("refuses a priced model the run didn't allow", () => {
    const broker = new RunBroker(PROFILE, CAPS, ["model-small"]);
    expect(broker.admit(ask({ model: "model-large" }))).toMatchObject({ ok: false, reason: "model_not_allowed" });
    expect(broker.admit(ask({ model: 7 }))).toMatchObject({ ok: false, reason: "body_invalid" });
  });

  it("refuses a body that isn't one JSON object, or is too large", () => {
    const broker = new RunBroker(PROFILE, CAPS, ["model-small"]);
    for (const body of ["", "[]", "null", "{", '"x"']) expect(broker.admit(request(body))).toMatchObject({ ok: false, reason: "body_invalid" });
    expect(broker.admit({ ...ask(), body: new Uint8Array(9 * 1024 * 1024) })).toMatchObject({ ok: false, reason: "body_too_large" });
  });

  it("prices tokens up, never down", () => {
    const price = PROFILE.prices["model-small"];
    expect(costOf(price, usage(1, 0))).toBe(1);
    expect(costOf(price, usage(0, 1))).toBe(5);
    expect(costOf(price, { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 1 })).toBe(1);
    expect(costOf(price, usage(1_000_000, 1_000_000))).toBe(6_000_000);
    // The worst case counts each body byte as an input token at the dearest input price, plus a fixed margin for the
    // provider's hidden tool prompt (M1 on #459), and all of max_tokens.
    expect(INPUT_MARGIN_TOKENS).toBe(4_096);
    expect(worstCaseOf(price, 1_000, 1_024)).toBe(Math.ceil(((1_000 + INPUT_MARGIN_TOKENS) * 1_250_000) / 1e6) + Math.ceil((1_024 * 5_000_000) / 1e6));
  });
});

describe("the spend cap", () => {
  it("refuses a request whose worst case would pass what's left, counting requests still in flight", () => {
    // Worst case of one request here: body bytes and the margin at 1.25 per token, plus 1,024 output tokens at 5 each.
    const broker = new RunBroker(PROFILE, { ...CAPS, spend_micro_usd: 22_000 }, ["model-small"]);
    const a = broker.admit(ask());
    const b = broker.admit(ask());
    expect(a.ok && b.ok).toBe(true);
    // Two in flight hold about 20,700 of 22,000, so a third can't fit even before either settles.
    expect(broker.admit(ask())).toMatchObject({ ok: false, reason: "spend_cap", hard_stop: true });
    expect(broker.totals.spent_micro_usd).toBeLessThanOrEqual(22_000);
  });

  it("never lets spend pass the cap, however a run spends", () => {
    const broker = new RunBroker(PROFILE, { ...CAPS, spend_micro_usd: 30_000, turns: 1_000 }, ["model-small"]);
    let refused = 0;
    for (let i = 0; i < 100; i++) {
      const admitted = broker.admit(ask());
      if (!admitted.ok) {
        refused++;
        continue;
      }
      // Each spends its whole bound: the worst the provider can do.
      broker.settle(admitted.forward.request_id, usage(admitted.forward.body.byteLength, admitted.forward.max_tokens));
    }
    expect(refused).toBeGreaterThan(0);
    expect(broker.totals.spent_micro_usd).toBeLessThanOrEqual(30_000);
  });

  it("counts a request's whole worst case when its usage never arrives or can't be read", () => {
    const broker = new RunBroker(PROFILE, CAPS, ["model-small"]);
    const cut = broker.admit(ask());
    const odd = broker.admit(ask());
    if (!cut.ok || !odd.ok) throw new Error("refused");
    broker.fail(cut.forward.request_id);
    broker.settle(odd.forward.request_id, { output_tokens: "many" });
    expect(broker.totals).toMatchObject({ spent_micro_usd: cut.forward.worst_micro_usd + odd.forward.worst_micro_usd, in_flight: 0 });
  });

  it("says when a settled request reaches a cap, so the run stops", () => {
    const broker = new RunBroker(PROFILE, { ...CAPS, spend_micro_usd: 12_000 }, ["model-small"]);
    const admitted = broker.admit(ask());
    if (!admitted.ok) throw new Error("refused");
    expect(broker.settle(admitted.forward.request_id, usage(100, 10))).toEqual({ cap_reached: null });
    const next = broker.admit(ask());
    if (!next.ok) throw new Error("refused");
    expect(broker.settle(next.forward.request_id, usage(7_000, 1_024))).toEqual({ cap_reached: "spend_cap" });
  });

  it("counts the provider's own usage when it reports more than was asked", () => {
    const broker = new RunBroker(PROFILE, CAPS, ["model-small"]);
    const admitted = broker.admit(ask());
    if (!admitted.ok) throw new Error("refused");
    broker.settle(admitted.forward.request_id, usage(10, 50_000));
    expect(broker.totals.output_tokens).toBe(50_000);
    expect(broker.admit(ask())).toMatchObject({ ok: false, hard_stop: true });
  });
});

describe("turns", () => {
  it("allows exactly the cap's model requests, then refuses as a hard stop", () => {
    const broker = new RunBroker(PROFILE, CAPS, ["model-small"]);
    for (let i = 0; i < CAPS.turns; i++) {
      const admitted = broker.admit(ask());
      if (!admitted.ok) throw new Error("refused");
      broker.settle(admitted.forward.request_id, usage(10, 10));
    }
    expect(broker.admit(ask())).toMatchObject({ ok: false, reason: "turns_exhausted", hard_stop: true });
    expect(broker.totals.turns).toBe(CAPS.turns);
  });

  it("refuses everything once closed, and a settle after that changes nothing it shouldn't", () => {
    const broker = new RunBroker(PROFILE, CAPS, ["model-small"]);
    const admitted = broker.admit(ask());
    if (!admitted.ok) throw new Error("refused");
    broker.close();
    expect(broker.admit(ask())).toMatchObject({ ok: false, reason: "run_stopped" });
    broker.settle(admitted.forward.request_id, usage(10, 10));
    expect(broker.totals.in_flight).toBe(0);
    broker.settle("req_unknown", usage(1, 1));
    expect(broker.totals.turns).toBe(1);
  });

  it("refuses caps that are missing, unset or out of range", () => {
    for (const bad of [{ spend_micro_usd: 0 }, { turns: 0 }, { output_tokens: -1 }, { max_tokens: 0 }, { max_tokens: 1.5 }, { turns: Number.POSITIVE_INFINITY }])
      expect(() => new RunBroker(PROFILE, { ...CAPS, ...bad }, ["model-small"])).toThrow();
  });
});

describe("the module is pure", () => {
  const code = readFileSync(fileURLToPath(new URL("../src/core/broker.ts", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  it("reads no clock, randomness, environment or network", () => {
    for (const banned of [/\bDate\b/, /Math\.random/, /\bcrypto\b/, /\bfetch\b/, /\bprocess\b/, /\bsetTimeout\b/, /\bimport\b/])
      expect([String(banned), banned.test(code)]).toEqual([String(banned), false]);
  });
});
