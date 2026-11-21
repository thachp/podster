// A fake OpenAI Responses upstream, in process: a `fetch` the transport calls instead of the network. It answers
// from a script of recorded-shape bodies and records what reached it. Synthetic content only.

export const TEST_KEY = `sk-proj-${"T".repeat(48)}`; // synthetic, matches the key pattern, not a real key

export function usage({ input = 100, output = 20, cached = 0, cacheWrite = 0, reasoning = 0, ttl12h } = {}) {
  const details = { cached_tokens: cached, cache_write_tokens: cacheWrite };
  if (ttl12h !== undefined) details.cache_write_tokens_details = { ttl_30m_tokens: cacheWrite, ttl_12h_tokens: ttl12h };
  return {
    input_tokens: input,
    input_tokens_details: details,
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: reasoning },
    total_tokens: input + output,
  };
}

let seq = 0;
const id = (p) => `${p}_${++seq}`;

/** A completed response with one function call. */
export function functionCall(name, args, u = usage()) {
  return {
    id: id("resp"), object: "response", status: "completed", model: "gpt-6-luna",
    output: [{ type: "function_call", id: id("fc"), call_id: id("call"), name, arguments: JSON.stringify(args), status: "completed" }],
    usage: u,
  };
}

/** A completed response with one assistant message. */
export function message(text, u = usage()) {
  return {
    id: id("resp"), object: "response", status: "completed", model: "gpt-6-luna",
    output: [{ type: "message", id: id("msg"), role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }],
    usage: u,
  };
}

/** An SSE body for a response: created, then the terminal event (`response.completed` unless told otherwise). */
export function sse(response, terminal = "response.completed") {
  const lines = [
    { type: "response.created", sequence_number: 0, response: { ...response, status: "in_progress", output: [], usage: null } },
    { type: terminal, sequence_number: 1, response },
  ];
  return lines.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

/**
 * The fake upstream. `script` is a list of answers: an object (sent as JSON 200), `{ httpStatus, body }`, `{ sse: text }`,
 * `{ hang: true }` (never answers until aborted), or a function of the parsed request body returning one of these.
 */
export function fakeUpstream(script) {
  const calls = []; // { url, method, authorization: "bearer-test-key" | other, redirect, body }
  const fetchImpl = async (url, init) => {
    const auth = init.headers?.authorization;
    const body = JSON.parse(new TextDecoder().decode(init.body));
    calls.push({ url, method: init.method, auth: auth === `Bearer ${TEST_KEY}` ? "test-key" : auth ? "other" : "none", redirect: init.redirect, headers: Object.keys(init.headers), body });
    let answer = script.shift();
    if (typeof answer === "function") answer = answer(body);
    if (answer === undefined) return new Response(JSON.stringify({ error: { message: "script empty" } }), { status: 500, headers: { "content-type": "application/json" } });
    if (answer.hang) {
      return new Promise((_, reject) => {
        const fail = () => reject(init.signal.reason ?? new Error("aborted"));
        if (init.signal?.aborted) fail();
        init.signal?.addEventListener("abort", fail, { once: true });
      });
    }
    if (answer.sse !== undefined) {
      const enc = new TextEncoder().encode(answer.sse);
      const cutAt = answer.cutAt ?? null;
      const stream = new ReadableStream({
        start(ctl) {
          ctl.enqueue(cutAt === null ? enc : enc.slice(0, cutAt));
          if (cutAt === null) ctl.close();
          else ctl.error(new Error("connection reset"));
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (answer.httpStatus) return new Response(JSON.stringify(answer.body ?? {}), { status: answer.httpStatus, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json", "x-request-id": "req_fake" } });
  };
  return { fetchImpl, calls };
}
