// The run's broker, in process. The driver's OpenAI client hands every request here through its `fetch`; the
// broker admits it (path, body allowlist, caps, worst-case reservation), forwards only the checked body to the one
// upstream through the provider transport, and settles the spend from the usage it reads back. No listener, no
// port. It never holds the key: only the transport does.

import { checkRequest, worstCaseOf, readUsage, costOf, SseUsageReader, readJsonAnswer } from "./dialect.mjs";
import { upstreamUrl, profileRefusal } from "./profile.mjs";

const MAX_ANSWER_BYTES = 16 * 1024 * 1024;

export class BrokerRefused extends Error {
  constructor(reason, detail, hardStop) {
    super(`model_request_refused: ${reason}${detail ? ` (${detail})` : ""}`);
    this.code = "model_request_refused";
    this.reason = reason;
    this.detail = detail ?? null;
    this.hardStop = hardStop;
  }
}

export class RunBroker {
  #transport;
  #inFlight = new Set();

  /**
   * `caps`: { spend_micro_usd, turns, output_tokens, max_tokens }. `transport.send(forward, signal)` returns a fetch
   * Response from the upstream; it is the only part that adds the key. `onStop(kind)` is called once on a hard stop.
   */
  constructor({ profile, caps, transport, onStop }) {
    const bad = profileRefusal(profile);
    if (bad) throw new Error(`profile refused: ${bad}`);
    this.profile = profile;
    this.caps = { ...caps };
    this.#transport = transport;
    this.onStop = onStop;
    this.state = {
      requests: 0, // forwarded upstream
      refused: {}, // reason -> count, refused before anything was sent
      spent_micro_usd: 0,
      reserved_micro_usd: 0,
      output_used: 0,
      output_reserved: 0,
      stopped: null,
      cut_in_flight: 0,
      records: [], // one per forwarded request: IDs, bounds, usage counts and charges only
    };
  }

  stop(kind) {
    if (this.state.stopped) return;
    this.state.stopped = kind;
    for (const abort of this.#inFlight) {
      this.state.cut_in_flight++;
      abort();
    }
    this.onStop?.(kind);
  }

  #refuse(reason, detail, hardStop = false) {
    this.state.refused[reason] = (this.state.refused[reason] ?? 0) + 1;
    if (hardStop) this.stop(reason);
    throw new BrokerRefused(reason, detail, hardStop);
  }

  /** Admission. Throws BrokerRefused; nothing is sent for a refused request. */
  #admit({ method, path, query, body }) {
    const s = this.state;
    if (s.stopped) this.#refuse("stopped", s.stopped);
    if (method !== "POST") this.#refuse("method");
    if (path !== this.profile.path) this.#refuse("path");
    if (query !== "") this.#refuse("query");
    if (s.requests >= this.caps.turns) this.#refuse("turns_exhausted", null, true);
    const outLeft = this.caps.output_tokens - s.output_used - s.output_reserved;
    if (outLeft < 1) this.#refuse("output_tokens_exhausted", null, true);
    const checked = checkRequest(body, this.profile, { maxOutputTokens: Math.min(this.caps.max_tokens, outLeft) });
    if (!checked.ok) this.#refuse(checked.reason, checked.detail);
    const price = this.profile.prices[checked.model];
    const worst = worstCaseOf(price, checked.body.byteLength, checked.max_output_tokens);
    if (s.spent_micro_usd + s.reserved_micro_usd + worst > this.caps.spend_micro_usd) this.#refuse("spend_cap", null, true);
    return { checked, price, worst };
  }

  /** One model request from the driver's fetch. Returns a Response for the OpenAI client. */
  async model(req, signal) {
    const { checked, price, worst } = this.#admit(req);
    const s = this.state;
    s.requests++;
    s.reserved_micro_usd += worst;
    s.output_reserved += checked.max_output_tokens;
    const rec = {
      request: s.requests,
      model: checked.model,
      stream: checked.stream,
      body_bytes: checked.body.byteLength,
      max_output_tokens: checked.max_output_tokens,
      worst_micro_usd: worst,
      status: null,
      terminal: null,
      incomplete_reason: null,
      usage: null,
      missing_usage_fields: [],
      charged_micro_usd: null,
      charged_worst: null,
      output_over_bound: null,
    };
    s.records.push(rec);

    const controller = new AbortController();
    const abort = () => controller.abort(new Error("broker_cut"));
    this.#inFlight.add(abort);
    const onCallerAbort = () => abort();
    signal?.addEventListener("abort", onCallerAbort, { once: true });
    let settled = false;
    const settle = (terminal, rawUsage) => {
      if (settled) return;
      settled = true;
      this.#inFlight.delete(abort);
      signal?.removeEventListener("abort", onCallerAbort);
      rec.terminal = terminal;
      const read = rawUsage === undefined ? null : readUsage(rawUsage);
      if (read) {
        rec.usage = read.usage;
        rec.missing_usage_fields = read.missing;
        const out = read.usage.output_tokens;
        if (out !== null) rec.output_over_bound = out > checked.max_output_tokens;
      }
      const useUsage = terminal === "completed" && read && read.missing.length === 0 && !read.unexpected;
      const charge = useUsage ? costOf(price, read.usage) : worst;
      rec.charged_micro_usd = charge;
      rec.charged_worst = !useUsage;
      s.reserved_micro_usd -= worst;
      s.output_reserved -= checked.max_output_tokens;
      s.spent_micro_usd += charge;
      s.output_used += useUsage ? read.usage.output_tokens + read.usage.reasoning_tokens : checked.max_output_tokens;
      if (read?.unexpected) this.stop("usage_unexpected");
      else if (s.spent_micro_usd >= this.caps.spend_micro_usd) this.stop("spend_cap");
      else if (s.output_used >= this.caps.output_tokens) this.stop("output_tokens_exhausted");
    };

    const forward = { url: upstreamUrl(this.profile), headers: { ...this.profile.headers }, body: checked.body };
    let up;
    try {
      up = await this.#transport.send(forward, controller.signal);
    } catch (err) {
      settle("error", undefined);
      throw err;
    }
    rec.status = up.status;
    const contentType = up.headers.get("content-type") ?? "";
    const outHeaders = { "content-type": contentType };
    const requestId = up.headers.get("x-request-id");
    if (requestId) outHeaders["x-request-id"] = requestId;

    if (up.ok && contentType.includes("text/event-stream") && up.body) {
      const reader = new SseUsageReader();
      const upReader = up.body.getReader();
      const stream = new ReadableStream({
        pull: async (ctl) => {
          try {
            const { done, value } = await upReader.read();
            if (done) {
              settle(reader.terminal ?? "cut", reader.usage);
              ctl.close();
              return;
            }
            reader.push(value);
            ctl.enqueue(value);
          } catch (err) {
            settle("cut", reader.usage);
            ctl.error(err);
          }
        },
        cancel: (why) => {
          settle("cut", reader.usage);
          upReader.cancel(why).catch(() => {});
          abort();
        },
      });
      return new Response(stream, { status: up.status, headers: outHeaders });
    }

    // Non-streamed, or an error answer: read it whole (bounded), then settle.
    let text;
    try {
      const buf = new Uint8Array(await up.arrayBuffer());
      if (buf.byteLength > MAX_ANSWER_BYTES) throw new Error("answer_too_large");
      text = new TextDecoder().decode(buf);
    } catch (err) {
      settle("cut", undefined);
      throw err;
    }
    if (!up.ok) {
      settle("error", undefined);
      return new Response(text, { status: up.status, headers: outHeaders });
    }
    const answer = readJsonAnswer(text);
    rec.incomplete_reason = answer.incomplete_reason;
    settle(answer.terminal, answer.usage);
    return new Response(text, { status: up.status, headers: outHeaders });
  }

  /** Cancel the run: refuse anything later and cut what is in flight. */
  cancel() {
    this.stop("cancelled");
  }

  get inFlight() {
    return this.#inFlight.size;
  }
}
