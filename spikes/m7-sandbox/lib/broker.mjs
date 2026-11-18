// The provider broker: the only place the provider key exists. It listens on loopback, accepts only
// POST /v1/messages for allow-listed models, adds the key, and keeps Runner's own spend and turn count
// from the usage the provider returns. Runner's hard stop lives here: once a cap is reached it refuses
// every later request and cuts any request still in flight. Nothing it logs or returns carries the key.

import http from "node:http";
import { readFileSync } from "node:fs";

const UPSTREAM = "https://api.anthropic.com";

// USD per million tokens. Input and output are Anthropic's list prices for claude-haiku-5-5 (as cached
// in the claude-api skill on 2026-11-03). Cache write and read are assumed at 1.25x and 0.1x input.
export const PRICES = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
};

/** Cost of one response's usage, in USD. */
export function costOf(model, usage) {
  const p = PRICES[model];
  if (!p || !usage) return 0;
  return (
    ((usage.input_tokens ?? 0) * p.input +
      (usage.output_tokens ?? 0) * p.output +
      (usage.cache_creation_input_tokens ?? 0) * p.cacheWrite +
      (usage.cache_read_input_tokens ?? 0) * p.cacheRead) /
    1e6
  );
}

const FORWARDED = ["anthropic-version", "anthropic-beta", "content-type", "accept"];
export const PLACEHOLDER = "placeholder-not-a-key";

/**
 * Start a broker for one run. `caps` are Runner's: { usd, turns } (Infinity for none).
 * `onCap(kind)` is called once, the moment a cap is reached, so Runner can cancel the run.
 */
export async function startBroker({ keyFile, models, caps, onCap, host = "127.0.0.1", canary = null, maxOutputTokens = null, reserve = false }) {
  const key = readFileSync(keyFile, "utf8").trim(); // never logged, never returned
  const state = {
    requests: 0, // requests forwarded to the provider
    completed: 0,
    refused: { path: 0, model: 0, stopped: 0, turns: 0 },
    refusedPaths: [],
    usd: 0,
    tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
    stopped: null, // { kind, at } once a cap is reached or Runner stops the run
    usdAtStop: null,
    inFlightAtStop: 0,
    cutInFlight: 0,
    sawAuthorizationHeader: false,
    clientKeyPlaceholderOnly: true,
    models: {},
    canarySeen: false, // a test marker found in a request body: host content reached the provider
    cutStreams: 0, // streams that ended without a final usage event
    estimatedOutputTokens: 0, // for cut streams: streamed delta characters / 2, deliberately high
    maxTokensRequested: 0, // the largest max_tokens Claude Code asked for, before any clamp
    clamped: 0, // requests whose max_tokens the broker lowered to Runner's per-request cap
    refusedByReservation: 0,
  };
  const inFlight = new Set();

  const stop = (kind) => {
    if (state.stopped) return;
    state.stopped = { kind, at: Date.now() };
    state.usdAtStop = state.usd;
    state.inFlightAtStop = inFlight.size;
    for (const abort of inFlight) {
      state.cutInFlight++;
      abort();
    }
    onCap?.(kind);
  };

  const add = (model, usage) => {
    state.usd += costOf(model, usage);
    state.tokens.input += usage.input_tokens ?? 0;
    state.tokens.output += usage.output_tokens ?? 0;
    state.tokens.cacheWrite += usage.cache_creation_input_tokens ?? 0;
    state.tokens.cacheRead += usage.cache_read_input_tokens ?? 0;
    if (state.usd >= caps.usd) stop("usd");
  };

  const server = http.createServer(async (req, res) => {
    const path = (req.url ?? "").split("?")[0];
    if (req.headers.authorization) state.sawAuthorizationHeader = true;
    const clientKey = req.headers["x-api-key"];
    if (clientKey && clientKey !== PLACEHOLDER) state.clientKeyPlaceholderOnly = false;

    const refuse = (why, status = 403) => {
      state.refused[why]++;
      if (why === "path" && state.refusedPaths.length < 10) state.refusedPaths.push(`${req.method} ${path}`.slice(0, 80));
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "permission_error", message: `broker refused: ${why}` } }));
    };
    if (req.method !== "POST" || path !== "/v1/messages") return refuse("path", 404);
    if (state.stopped) return refuse("stopped", 429);

    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    let body;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      return refuse("path", 400);
    }
    if (canary && raw.includes(canary)) state.canarySeen = true;
    if (!models.includes(body.model)) return refuse("model");
    state.maxTokensRequested = Math.max(state.maxTokensRequested, Number(body.max_tokens) || 0);
    // Runner's own per-request output cap: the broker rewrites max_tokens, whatever the client asked.
    let forward = raw;
    if (maxOutputTokens && !(Number(body.max_tokens) <= maxOutputTokens)) {
      body.max_tokens = maxOutputTokens;
      forward = Buffer.from(JSON.stringify(body));
      state.clamped++;
    }
    // Reservation: refuse a request whose worst case (every body byte an input token, the full max_tokens
    // of output, at list prices) would take spend past the cap. Spend then can't pass the cap.
    if (reserve) {
      const p = PRICES[body.model];
      const worst = (forward.length * p.input + Number(body.max_tokens) * p.output) / 1e6;
      if (state.usd + worst > caps.usd) {
        state.refusedByReservation++;
        stop("usd");
        return refuse("stopped", 429);
      }
    }
    if (state.requests >= caps.turns) {
      stop("turns");
      return refuse("turns", 429);
    }
    state.requests++;
    state.models[body.model] = (state.models[body.model] ?? 0) + 1;

    const headers = { "x-api-key": key };
    for (const h of FORWARDED) if (req.headers[h]) headers[h] = req.headers[h];
    const controller = new AbortController();
    let usage = {};
    let deltaChars = 0;
    let finished = false;
    const abort = () => {
      controller.abort();
      res.destroy();
    };
    inFlight.add(abort);
    try {
      const up = await fetch(UPSTREAM + req.url, { method: "POST", headers, body: forward, signal: controller.signal });
      const out = {};
      for (const h of ["content-type", "request-id"]) if (up.headers.get(h)) out[h] = up.headers.get(h);
      res.writeHead(up.status, out);
      const streaming = (up.headers.get("content-type") ?? "").includes("text/event-stream");
      let buf = "";
      const reader = up.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
        buf += dec.decode(value, { stream: true });
        if (!streaming) continue;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (!line.startsWith("data: ")) continue;
          try {
            const ev = JSON.parse(line.slice(6));
            if (ev.type === "message_start") usage = { ...ev.message.usage };
            if (ev.type === "message_delta" && ev.usage) usage = { ...usage, ...ev.usage };
            if (ev.type === "content_block_delta") deltaChars += (ev.delta?.text ?? ev.delta?.partial_json ?? ev.delta?.thinking ?? "").length;
            if (ev.type === "message_stop") finished = true;
          } catch {}
        }
      }
      if (!streaming) {
        try {
          usage = JSON.parse(buf).usage ?? {};
        } catch {}
      }
      if (!streaming) finished = true;
      state.completed++;
      res.end();
    } catch {
      if (!res.destroyed) res.destroy();
    } finally {
      inFlight.delete(abort);
      // A cut stream still bills what message_start reported and the output generated before the cut, which
      // no usage event reports. Runner counts it from the streamed characters, on the high side.
      if (!finished) {
        state.cutStreams++;
        const est = Math.ceil(deltaChars / 2);
        if (est > (usage.output_tokens ?? 0)) {
          state.estimatedOutputTokens += est - (usage.output_tokens ?? 0);
          usage = { ...usage, output_tokens: est };
        }
      }
      add(body.model, usage);
    }
  });

  await new Promise((r) => server.listen(0, host, r));
  const { port } = server.address();
  return { port, state, stop, close: () => new Promise((r) => server.close(() => r())) };
}
