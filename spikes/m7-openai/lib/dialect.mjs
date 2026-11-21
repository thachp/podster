// The broker's OpenAI Responses dialect (RUNNER-OPENAI.md, "The broker profile"): the request-body allowlist,
// the output bound and forced keys, the worst case, and how usage is read and priced. Pure: no I/O.

/** Every body byte may be a token; this margin covers what the provider adds around them. */
export const INPUT_MARGIN_TOKENS = 4_096;
export const MAX_BODY_BYTES = 8 * 1024 * 1024;

/** Top-level keys the broker lets through. Anything else is refused by name. */
const ALLOWED_KEYS = new Set([
  "model", "input", "instructions", "tools", "tool_choice", "parallel_tool_calls", "max_output_tokens", "store",
  "stream", "include", "reasoning", "text", "temperature", "top_p", "truncation",
]);

/** Keys the design refuses by name: work, state or spend outside Runner's tools and its worst case. */
export const REFUSED_KEYS = Object.freeze([
  "background", "background_options", "conversation", "previous_response_id", "prompt", "context_management",
  "prompt_cache_options", "prompt_cache_retention", "prompt_cache_key", "service_tier", "max_tool_calls", "metadata",
  "safety_identifier", "user", "moderation", "access_programs", "image", "top_logprobs", "stream_options",
]);

/** Hosted tool types, refused by type. Only `function` passes. */
export const HOSTED_TOOL_TYPES = Object.freeze([
  "web_search", "web_search_preview", "web_search_2025_08_26", "web_search_preview_2025_03_11", "file_search",
  "code_interpreter", "computer", "computer_use_preview", "computer_use", "mcp", "shell", "local_shell", "apply_patch",
  "image_generation", "programmatic_tool_calling", "tool_search", "custom", "namespace",
]);

const REASONING_EFFORTS = new Set(["minimal", "low", "medium"]);
const REASONING_SUMMARIES = new Set(["none", "auto"]);
const ITEM_FIELDS = {
  message: new Set(["type", "id", "role", "status", "content"]),
  function_call: new Set(["type", "id", "call_id", "name", "arguments", "status"]),
  function_call_output: new Set(["type", "id", "call_id", "output", "status"]),
  reasoning: new Set(["type", "id", "summary", "encrypted_content", "content", "status"]),
};
const TEXT_PART_FIELDS = new Set(["type", "text", "annotations", "logprobs"]);

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const refuse = (reason, detail) => ({ ok: false, reason, detail });

function onlyFields(obj, allowed) {
  for (const k of Object.keys(obj)) if (!allowed.has(k)) return k;
  return null;
}

function checkTextParts(content, roleTypes) {
  if (typeof content === "string") return null;
  if (!Array.isArray(content)) return "content";
  for (const part of content) {
    if (!isObj(part) || !roleTypes.includes(part.type) || typeof part.text !== "string") return `content_part:${part?.type}`;
    const extra = onlyFields(part, TEXT_PART_FIELDS);
    if (extra) return `content_field:${extra}`;
  }
  return null;
}

function checkInput(input, toolNames) {
  if (typeof input === "string") return null;
  if (!Array.isArray(input)) return "input";
  for (const item of input) {
    if (!isObj(item)) return "input_item";
    const type = item.type ?? (item.role !== undefined ? "message" : undefined);
    const fields = ITEM_FIELDS[type];
    if (!fields) return `input_type:${type}`;
    const extra = onlyFields(item, fields);
    if (extra) return `input_field:${type}.${extra}`;
    if (type === "message") {
      if (item.role !== "user" && item.role !== "assistant") return `input_role:${item.role}`;
      const bad = checkTextParts(item.content, item.role === "user" ? ["input_text"] : ["output_text", "input_text"]);
      if (bad) return `input_${bad}`;
    } else if (type === "function_call") {
      if (!toolNames.has(item.name)) return "input_function_name";
      if (typeof item.arguments !== "string" || typeof item.call_id !== "string") return "input_function_call";
    } else if (type === "function_call_output") {
      if (typeof item.call_id !== "string") return "input_function_output";
      if (typeof item.output !== "string" && checkTextParts(item.output, ["input_text"])) return "input_function_output";
    } else if (type === "reasoning") {
      if (item.encrypted_content !== undefined && typeof item.encrypted_content !== "string") return "input_reasoning";
      if (item.content !== undefined && !(Array.isArray(item.content) && item.content.length === 0)) return "input_reasoning_content";
    }
  }
  return null;
}

function checkTools(tools) {
  if (!Array.isArray(tools)) return { bad: "tools" };
  const names = new Set();
  for (const t of tools) {
    if (!isObj(t)) return { bad: "tools" };
    if (t.type !== "function") return { bad: `tool_type:${t.type}` };
    const extra = onlyFields(t, new Set(["type", "name", "description", "parameters", "strict"]));
    if (extra) return { bad: `tool_field:${extra}` };
    if (typeof t.name !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(t.name)) return { bad: "tool_name" };
    names.add(t.name);
  }
  return { names };
}

function checkToolChoice(choice, names) {
  if (choice === "auto" || choice === "required" || choice === "none") return null;
  if (isObj(choice) && choice.type === "function" && names.has(choice.name) && Object.keys(choice).length === 2) return null;
  return "tool_choice";
}

/**
 * Check one request body and rewrite it. `maxOutputTokens` is the broker's bound for this request:
 * min(caps.max_tokens, output tokens left). Returns the body to forward (re-serialized from what was checked, so
 * a duplicate key can't slip past), the model and the bound sent.
 */
export function checkRequest(raw, profile, { maxOutputTokens }) {
  if (!(raw instanceof Uint8Array)) return refuse("body");
  if (raw.byteLength > MAX_BODY_BYTES) return refuse("body_size");
  let body;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    return refuse("body_json");
  }
  if (!isObj(body)) return refuse("body_json");
  for (const key of Object.keys(body)) {
    if (REFUSED_KEYS.includes(key)) return refuse("refused_key", key);
    if (!ALLOWED_KEYS.has(key)) return refuse("unknown_key", key);
  }
  if (typeof body.model !== "string" || !Object.hasOwn(profile.prices, body.model)) return refuse("model");
  if (body.instructions !== undefined && typeof body.instructions !== "string") return refuse("instructions");

  const tools = checkTools(body.tools ?? []);
  if (tools.bad) return refuse("tools", tools.bad);
  if (body.tool_choice !== undefined) {
    const bad = checkToolChoice(body.tool_choice, tools.names);
    if (bad) return refuse(bad);
  }
  const badInput = checkInput(body.input, tools.names);
  if (badInput) return refuse("input", badInput);

  if (body.parallel_tool_calls !== undefined && typeof body.parallel_tool_calls !== "boolean") return refuse("parallel_tool_calls");
  if (body.stream !== undefined && typeof body.stream !== "boolean") return refuse("stream");
  if (body.include !== undefined) {
    const inc = body.include;
    const ok = Array.isArray(inc) && (inc.length === 0 || (inc.length === 1 && inc[0] === "reasoning.encrypted_content"));
    if (!ok) return refuse("include");
  }
  if (body.reasoning !== undefined) {
    const r = body.reasoning;
    if (!isObj(r) || onlyFields(r, new Set(["effort", "summary"]))) return refuse("reasoning");
    if (r.effort !== undefined && !REASONING_EFFORTS.has(r.effort)) return refuse("reasoning_effort");
    if (r.summary !== undefined && r.summary !== null && !REASONING_SUMMARIES.has(r.summary)) return refuse("reasoning_summary");
  }
  if (body.text !== undefined) {
    const t = body.text;
    if (!isObj(t) || onlyFields(t, new Set(["format", "verbosity"]))) return refuse("text");
    if (t.format !== undefined && !(isObj(t.format) && (t.format.type === "text" || t.format.type === "json_schema"))) return refuse("text_format");
  }
  for (const k of ["temperature", "top_p"]) if (body[k] !== undefined && typeof body[k] !== "number") return refuse(k);
  if (body.truncation !== undefined && body.truncation !== "disabled") return refuse("truncation");

  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1) return refuse("output_bound");
  const asked = body.max_output_tokens;
  if (asked !== undefined && asked !== null && !(Number.isInteger(asked) && asked > 0)) return refuse("max_output_tokens");
  const bound = asked ? Math.min(asked, maxOutputTokens) : maxOutputTokens;
  body.max_output_tokens = bound;
  body.store = false;

  const out = new TextEncoder().encode(JSON.stringify(body));
  return { ok: true, body: out, model: body.model, max_output_tokens: bound, stream: body.stream === true };
}

/** The rates for an input measure: the long-context tier when the measure is above its threshold. */
function ratesFor(price, inputMeasure) {
  const lc = price.long_context;
  return lc && inputMeasure > lc.above_input_tokens ? lc : price;
}

/** Worst case in micro-USD: body bytes plus a margin at the dearest input rate, plus the whole bound at the output rate. */
export function worstCaseOf(price, bodyBytes, maxOutputTokens) {
  const inTokens = bodyBytes + INPUT_MARGIN_TOKENS;
  const r = ratesFor(price, inTokens);
  return Math.ceil((inTokens * Math.max(r.input, r.cache_write) + maxOutputTokens * r.output) / 1e6);
}

/**
 * Read a Responses `usage` object. Returns null when a field the pricing needs is missing or not a count, so the
 * caller counts the worst case. `unexpected` is set when 12-hour cache writes appear, which the spike never asks for.
 */
export function readUsage(usage) {
  if (!isObj(usage)) return null;
  const n = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
  const u = {
    input_tokens: n(usage.input_tokens),
    output_tokens: n(usage.output_tokens),
    total_tokens: n(usage.total_tokens),
    cached_tokens: n(usage.input_tokens_details?.cached_tokens),
    cache_write_tokens: n(usage.input_tokens_details?.cache_write_tokens),
    reasoning_tokens: n(usage.output_tokens_details?.reasoning_tokens),
  };
  const missing = Object.entries(u).filter(([, v]) => v === null).map(([k]) => k);
  const ttl12h = usage.input_tokens_details?.cache_write_tokens_details?.ttl_12h_tokens;
  const unexpected = typeof ttl12h === "number" && ttl12h > 0;
  return { usage: u, missing, unexpected };
}

/**
 * Price a read usage, in micro-USD, on the overcounting reading the design requires until the spike settles the
 * nesting: cached and cache-write tokens on top of `input_tokens`, reasoning tokens on top of `output_tokens`.
 */
export function costOf(price, u) {
  const inputMeasure = u.input_tokens + u.cached_tokens + u.cache_write_tokens;
  const r = ratesFor(price, inputMeasure);
  return Math.ceil(
    (u.input_tokens * r.input + u.cached_tokens * r.cache_read + u.cache_write_tokens * r.cache_write + (u.output_tokens + u.reasoning_tokens) * r.output) / 1e6,
  );
}

/**
 * Reads a Responses event stream as it passes. Only `response.completed` yields usage; `response.failed`,
 * `response.incomplete` and `error` are terminal failures, and a stream that ends without any terminal event was cut.
 */
export class SseUsageReader {
  #buf = "";
  #dec = new TextDecoder();
  terminal = null; // "completed" | "failed" | "incomplete" | "error"
  usage = undefined; // the raw usage object of the terminal event, when it carried one
  events = 0;

  push(chunk) {
    this.#buf += this.#dec.decode(chunk, { stream: true });
    let i;
    while ((i = this.#buf.indexOf("\n")) >= 0) {
      const line = this.#buf.slice(0, i).replace(/\r$/, "");
      this.#buf = this.#buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "" || data === "[DONE]") continue;
      let ev;
      try {
        ev = JSON.parse(data);
      } catch {
        continue;
      }
      this.events++;
      if (ev.type === "response.completed") this.#end("completed", ev.response?.usage);
      else if (ev.type === "response.failed") this.#end("failed", ev.response?.usage);
      else if (ev.type === "response.incomplete") this.#end("incomplete", ev.response?.usage);
      else if (ev.type === "error") this.#end("error", undefined);
    }
  }

  #end(kind, usage) {
    if (this.terminal) return;
    this.terminal = kind;
    this.usage = usage;
  }
}

/** The terminal state of a non-streamed answer's JSON. */
export function readJsonAnswer(text) {
  try {
    const j = JSON.parse(text);
    const status = j?.status;
    const terminal = status === "completed" ? "completed" : status === "incomplete" ? "incomplete" : status === "failed" ? "failed" : "error";
    return { terminal, usage: j?.usage, incomplete_reason: j?.incomplete_details?.reason ?? null };
  } catch {
    return { terminal: "error", usage: undefined, incomplete_reason: null };
  }
}
