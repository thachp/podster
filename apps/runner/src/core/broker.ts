/**
 * Runner's provider broker, its pure part (M7 step 9(a); the architect's rulings 3 and 5 on spike B). The hard stop for
 * spend, turns and output tokens lives here, not in any SDK (S-37, S-42):
 *
 * - **A fixed upstream.** A request goes only to the URL built from the provider profile's fixed parts, in the adapter's
 *   own code. Nothing is copied from the request: not its host, path, query or headers. It must name the profile's one
 *   path, with no query, by POST.
 * - **`max_tokens` is rewritten on every request** to the run's bound, and never above what's left of the run's output
 *   tokens. The body is parsed and written again, so a duplicate key can't carry another value past the rewrite.
 * - **The worst case is reserved before a request goes.** Each body byte counts as an input token at the dearest input
 *   price, plus a fixed margin for the provider's hidden tool prompt, and all of `max_tokens` as output. A request whose worst case would pass what's left of the spend cap, after
 *   every request still in flight, is refused. So spend never passes the cap on the provider's own usage.
 * - **Only a known body** (M1 on #459): known top-level keys, `output_config`, adaptive `thinking`, top-level
 *   `cache_control` and a tool's `eager_input_streaming` only in their reviewed shapes (three reviewed widenings, all
 *   2026-11-18), and a system-role message of text only (the fourth); every beta-only key and every other declared key not ruled in stays refused by name; tools only the driver's own (`custom`), never the
 *   provider's server tools; content blocks only text, image or document (base64 or text sources), tool use, tool results
 *   and thinking, with documents in plain text only (a PDF bills beyond the body's bytes); no MCP servers, container, speed or service tier, and no cache lifetime. Anything else could act or
 *   spend outside Runner's tools and its worst case. A profile's fixed headers may not turn on a beta.
 * - **A model with no price is refused,** never counted as free. A run's model list is checked against the price table
 *   when the broker is made.
 * - **Turns** are model requests: exactly the cap's number go, and the next is refused.
 * - A refusal for spend, turns or output tokens is a hard stop: the run is cancelled (`run-interface.ts`).
 *
 * What it counts is Runner's own running total. Usage the provider reports is priced here; a request whose usage never
 * arrives, or can't be read, counts its whole worst case. An SDK's own spend figure is never read.
 *
 * Pure: no clock, no network, no randomness. Step 9(b) feeds it from a loopback listener and forwards through a transport
 * that adds the owner's key, outside the task's container. Logs and refusals carry codes only.
 *
 * **Dialects** (RUNNER-OPENAI.md; 2026-11-22): a profile names the body format it speaks. `anthropic_messages`, the
 * default, is everything above, unchanged. `openai_responses` (the experimental OpenAI adapter, off by default) swaps in
 * the Responses body allowlist below, rewrites `max_output_tokens` instead of `max_tokens`, forces `store: false`,
 * never sends a request whose bound is below `OPENAI_MIN_OUTPUT_BOUND` (the reasoning headroom rule), reads usage nested,
 * and stops the run on a usage it doesn't expect (`usage_unexpected`). Spend, turns, the worst case and the caps are the
 * same code for both.
 */

export type Dialect = "anthropic_messages" | "openai_responses";
export const dialectOf = (profile: ProviderProfile): Dialect => profile.dialect ?? "anthropic_messages";

/** Micro-USD per million tokens, as integers. */
export type Rates = { input: number; output: number; cache_write: number; cache_read: number };
/**
 * A model's prices. `long_context`, when the provider has one, applies to the whole request once its input (counting
 * cache writes and reads) is above `above_input_tokens`; the worst case always takes the dearest tier (L6 on #460).
 */
export type Price = Rates & { long_context?: Rates & { above_input_tokens: number } };

/** A provider, as an adapter's code fixes it. Never read from configuration, the task or Podster. */
export type ProviderProfile = {
  provider: string;
  /** The body format the broker checks and the transport reads: `anthropic_messages` when left out. */
  dialect?: Dialect;
  /** The upstream's host name, without scheme, port, user or path. */
  host: string;
  /** The one path requests may name, and the one they're sent to. */
  path: string;
  /** Headers every forwarded request carries; the transport adds the key. */
  headers: Record<string, string>;
  prices: Record<string, Price>;
};

export type BrokerCaps = { spend_micro_usd: number; turns: number; output_tokens: number; max_tokens: number };

/** What the listener hands in: no headers at all, since none is ever forwarded. */
export type BrokerRequest = { method: string; path: string; query: string; body: Uint8Array };

export type Forward = { request_id: string; url: string; headers: Record<string, string>; body: Uint8Array; max_tokens: number; worst_micro_usd: number };

export type BrokerRefusal =
  | "method_not_allowed"
  | "path_not_allowed"
  | "query_not_allowed"
  | "body_too_large"
  | "body_invalid"
  | "body_not_allowed"
  | "model_not_allowed"
  | "model_unpriced"
  | "turns_exhausted"
  | "output_tokens_exhausted"
  | "spend_cap"
  | "run_stopped";

/** Refusals that end the run, and `usage_unexpected`: a settled usage the dialect says Runner never asked for. */
export type HardStop = "turns_exhausted" | "output_tokens_exhausted" | "spend_cap" | "usage_unexpected";
const HARD: ReadonlySet<BrokerRefusal> = new Set<BrokerRefusal>(["turns_exhausted", "output_tokens_exhausted", "spend_cap"]);

/**
 * `detail`, on a refused body only: which part was refused, as a fixed code naming a key or a type, never a value
 * (`top_key:output_config`, `thinking:adaptive`, `block:server_tool_use`), so a refusal can be reviewed by name.
 */
export type Admission = { ok: true; forward: Forward } | { ok: false; reason: BrokerRefusal; hard_stop: boolean; detail?: string };

export type Usage = { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number };

/** The largest request body taken: far above a run's needs, and bounded so a body can't exhaust Runner. */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** Input tokens added to every request's worst case for what the provider adds unseen, such as its tool-use prompt. */
export const INPUT_MARGIN_TOKENS = 4_096;

const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PATH = /^(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)+$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isCap = (v: unknown): v is number => isCount(v) && v > 0;

/** Fixed headers no profile may carry: a beta, an OpenAI organization or project, or any authorization of its own. */
const REFUSED_FIXED_HEADERS = ["anthropic-beta", "openai-beta", "openai-organization", "openai-project", "authorization", "x-api-key"];

function checkProfile(profile: ProviderProfile) {
  if (Object.keys(profile.headers).some((name) => REFUSED_FIXED_HEADERS.includes(name.toLowerCase()))) throw new Error("the provider profile's fixed headers may not turn on a beta, name an organization or project, or carry an authorization");
  if (profile.dialect !== undefined && profile.dialect !== "anthropic_messages" && profile.dialect !== "openai_responses") throw new Error("the provider profile names a dialect Runner doesn't have");
  const labels = profile.host.split(".");
  if (profile.host.length > 253 || labels.length < 2 || !labels.every((l) => HOST_LABEL.test(l))) throw new Error("the provider profile's host isn't a plain host name");
  if (!PATH.test(profile.path) || profile.path.split("/").some((s) => s === "." || s === "..")) throw new Error("the provider profile's path isn't a plain path");
  for (const [model, price] of Object.entries(profile.prices)) {
    if (!MODEL.test(model)) throw new Error("the provider profile names a model Runner can't take");
    if (![price.input, price.output, price.cache_write, price.cache_read].every(isCount)) throw new Error("the provider profile has a price that isn't a whole number of micro-USD");
    const long = price.long_context;
    if (long !== undefined && ![long.input, long.output, long.cache_write, long.cache_read, long.above_input_tokens].every(isCount)) throw new Error("the provider profile has a price that isn't a whole number of micro-USD");
  }
}

/** The one URL a request is forwarded to, from the profile's fixed parts. */
export function upstreamUrl(profile: ProviderProfile): string {
  checkProfile(profile);
  return `https://${profile.host}${profile.path}`;
}

const priced = (tokens: number, perMillion: number) => Math.ceil((tokens * perMillion) / 1_000_000);

/** What usage costs, rounded up, at the tier its input falls in. */
export function costOf(price: Price, usage: Usage): number {
  const input = usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens;
  const r: Rates = price.long_context !== undefined && input > price.long_context.above_input_tokens ? price.long_context : price;
  return priced(usage.input_tokens, r.input) + priced(usage.output_tokens, r.output) + priced(usage.cache_creation_input_tokens, r.cache_write) + priced(usage.cache_read_input_tokens, r.cache_read);
}

/**
 * The most a request can cost: each body byte, plus the margin, as an input token at the dearest input price, and all
 * of `max_tokens` as output. The tier is the one that bound on input falls in: the long-context tier only when it is
 * above that tier's threshold (re-review item 4 on #460), since a request's input tokens can't pass its bound.
 */
export function worstCaseOf(price: Price, bodyBytes: number, maxTokens: number): number {
  const bound = bodyBytes + INPUT_MARGIN_TOKENS;
  const r: Rates = price.long_context !== undefined && bound > price.long_context.above_input_tokens ? price.long_context : price;
  return priced(bound, Math.max(r.input, r.cache_write, r.cache_read)) + priced(maxTokens, r.output);
}

function usageOf(v: unknown): Usage | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const u = v as Record<string, unknown>;
  const input = u.input_tokens;
  const output = u.output_tokens;
  const write = u.cache_creation_input_tokens ?? 0;
  const read = u.cache_read_input_tokens ?? 0;
  if (!isCount(input) || !isCount(output) || !isCount(write) || !isCount(read)) return null;
  return { input_tokens: input, output_tokens: output, cache_creation_input_tokens: write, cache_read_input_tokens: read };
}

// ---- The body allowlist (M1 on #459) ----

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const only = (o: Obj, keys: readonly string[]) => Object.keys(o).every((k) => keys.includes(k));
const optional = (v: unknown, check: (v: unknown) => boolean) => v === undefined || check(v);
const isText = (v: unknown) => typeof v === "string";

const TOP_KEYS = ["model", "messages", "max_tokens", "system", "metadata", "stop_sequences", "stream", "temperature", "top_k", "top_p", "tools", "tool_choice", "thinking", "output_config", "cache_control"];

/** `output_config.effort`, exactly the enum the pinned SDK 0.3.327 declares (its Messages `OutputConfig` type). */
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/**
 * `output_config`, the first reviewed widening of the allowlist (the architect's ruling of 2026-11-18, after #460's
 * third real run, where Claude Code sent it on every request): an object holding at most `effort`, from the SDK's
 * enum, and `format`, exactly `{ type: "json_schema", schema: {…} }`. Any other key is refused by name. It touches
 * neither `max_tokens` nor the worst case, which are computed the same with or without it.
 */
function outputConfigRefusal(v: unknown): string | null {
  if (!isObj(v)) return "output_config";
  const extra = Object.keys(v).find((k) => k !== "effort" && k !== "format");
  if (extra !== undefined) return `output_config_key:${nameCode(extra)}`;
  if (v.effort !== undefined && !(typeof v.effort === "string" && EFFORTS.includes(v.effort))) return "output_config:effort";
  if (v.format !== undefined) {
    const f = v.format;
    if (!isObj(f) || !only(f, ["type", "schema"]) || f.type !== "json_schema" || !isObj(f.schema)) return "output_config:format";
  }
  return null;
}

/** Only `{ type: "ephemeral" }`: no lifetime, which would buy a longer, dearer cache. */
const cacheOk = (v: unknown) => v === undefined || (isObj(v) && only(v, ["type"]) && v.type === "ephemeral");

function sourceOk(v: unknown, kinds: readonly string[]): boolean {
  if (!isObj(v) || typeof v.type !== "string" || !kinds.includes(v.type)) return false;
  return only(v, ["type", "media_type", "data"]) && isText(v.media_type) && isText(v.data);
}

/** A content block; inside a tool result, only text, images and documents. */
function blockOk(v: unknown, inResult = false): boolean {
  if (!isObj(v) || typeof v.type !== "string" || !cacheOk(v.cache_control)) return false;
  switch (v.type) {
    case "text":
      return only(v, ["type", "text", "cache_control"]) && isText(v.text);
    case "image":
      return only(v, ["type", "source", "cache_control"]) && sourceOk(v.source, ["base64"]);
    case "document":
      return only(v, ["type", "source", "cache_control", "title", "context"]) && sourceOk(v.source, ["base64", "text"]) && (v.source as Obj).media_type === "text/plain" && optional(v.title, isText) && optional(v.context, isText);
    case "tool_use":
      return !inResult && only(v, ["type", "id", "name", "input", "cache_control"]) && isText(v.id) && isText(v.name) && isObj(v.input);
    case "tool_result":
      return !inResult && only(v, ["type", "tool_use_id", "content", "is_error", "cache_control"]) && isText(v.tool_use_id) && optional(v.is_error, (e) => typeof e === "boolean") && optional(v.content, (c) => isText(c) || (Array.isArray(c) && c.every((b) => blockOk(b, true))));
    case "thinking":
      return !inResult && only(v, ["type", "thinking", "signature"]) && isText(v.thinking) && optional(v.signature, isText);
    case "redacted_thinking":
      return !inResult && only(v, ["type", "data"]) && isText(v.data);
    default:
      return false;
  }
}

const contentOk = (v: unknown) => isText(v) || (Array.isArray(v) && v.every((b) => blockOk(b)));

/** A tool's keys. `eager_input_streaming`, a boolean, is the third reviewed widening's (2026-11-18). */
const TOOL_KEYS = ["type", "name", "description", "input_schema", "cache_control", "eager_input_streaming"];

function toolOk(v: unknown): boolean {
  if (!isObj(v) || !only(v, TOOL_KEYS)) return false;
  return (v.type === undefined || v.type === "custom") && isText(v.name) && optional(v.description, isText) && isObj(v.input_schema) && cacheOk(v.cache_control) && optional(v.eager_input_streaming, (e) => typeof e === "boolean");
}

/** A name from the request as a code: itself if it's a plain identifier, else `other`. */
const nameCode = (v: unknown) => (typeof v === "string" && /^[a-z][a-z0-9_]{0,39}$/.test(v) ? v : "other");

/** The first part of a content block outside the allowlist, as a code; null when the block is allowed. */
/** Each block type's keys, as `blockOk` takes them. */
const BLOCK_KEYS: Record<string, readonly string[]> = {
  text: ["type", "text", "cache_control"],
  image: ["type", "source", "cache_control"],
  document: ["type", "source", "cache_control", "title", "context"],
  tool_use: ["type", "id", "name", "input", "cache_control"],
  tool_result: ["type", "tool_use_id", "content", "is_error", "cache_control"],
  thinking: ["type", "thinking", "signature"],
  redacted_thinking: ["type", "data"],
};
/** Only these may sit inside a tool result's content. */
const RESULT_BLOCKS = ["text", "image", "document"];
/** A media type as a code: itself when it is a plain `kind/subtype`, else `other`. */
const mediaCode = (v: unknown) => (typeof v === "string" && /^[a-z]+\/[a-z0-9.+-]{1,40}$/.test(v) ? v : "other");

/**
 * The first part of a content block outside the allowlist, as a precise code (the sixth real run of #460); null when
 * the block is allowed. It refuses exactly what `blockOk` refuses: the code only says where.
 */
function blockRefusal(v: unknown, inResult = false): string | null {
  if (blockOk(v, inResult)) return null;
  if (!isObj(v) || typeof v.type !== "string" || !Object.hasOwn(BLOCK_KEYS, v.type)) return `${inResult ? "tool_result_content_type" : "content_type"}:${nameCode(isObj(v) ? v.type : undefined)}`;
  const type = v.type;
  if (inResult && !RESULT_BLOCKS.includes(type)) return `tool_result_content_type:${type}`;
  const extra = Object.keys(v).find((k) => !BLOCK_KEYS[type].includes(k));
  if (extra !== undefined) return `block_key:${type}.${nameCode(extra)}`;
  if (v.cache_control !== undefined && !cacheOk(v.cache_control)) return isObj(v.cache_control) && Object.hasOwn(v.cache_control, "ttl") ? "cache_control_ttl" : "cache_control";
  if (type === "image" || type === "document") {
    const source = v.source;
    if (!isObj(source)) return `block_shape:${type}`;
    const kinds = type === "image" ? ["base64"] : ["base64", "text"];
    if (!kinds.includes(source.type as string)) return `source_type:${nameCode(source.type)}`;
    if (type === "document" && source.media_type !== "text/plain") return `media_type:${mediaCode(source.media_type)}`;
  }
  if (type === "tool_result" && Array.isArray(v.content)) {
    for (const inner of v.content) {
      const refused = blockRefusal(inner, true);
      if (refused !== null) return refused;
    }
  }
  return `block_shape:${type}`;
}

/**
 * A system-role message's content blocks: the fourth reviewed widening (the architect's ruling of 2026-11-18, after
 * #460's seventh real run, where Claude Code sent one with every request). Only `text` blocks, each with at most an
 * ephemeral `cache_control`, as with a string. The architect's reasoning: it is Claude Code's own system-reminder text,
 * not the task's, so it gives the model nothing beyond the system prompt Runner already sends; its bytes count toward
 * the worst case like any other content.
 */
function systemMessageRefusal(blocks: unknown[]): string | null {
  for (const block of blocks) {
    if (!isObj(block) || typeof block.type !== "string") return "system_message_shape";
    if (block.type !== "text") return `system_message_type:${nameCode(block.type)}`;
    const extra = Object.keys(block).find((k) => k !== "type" && k !== "text" && k !== "cache_control");
    if (extra !== undefined) return `system_message_key:${nameCode(extra)}`;
    if (block.cache_control !== undefined && !cacheOk(block.cache_control)) return isObj(block.cache_control) && Object.hasOwn(block.cache_control, "ttl") ? "cache_control_ttl" : "cache_control";
    if (!isText(block.text)) return "system_message_shape";
  }
  return null;
}

/** `thinking.display` for adaptive thinking, exactly the enum SDK 0.3.327 declares (its `ThinkingConfigAdaptive`). */
const THINKING_DISPLAYS = ["summarized", "omitted"];

/**
 * `thinking`, as the allowlist takes it. The second reviewed widening (the architect's ruling of 2026-11-18, after
 * #460's fourth real run, where Claude Code sent adaptive thinking on every request) adds `{ type: "adaptive" }`, with
 * an optional `display` from the SDK's enum; `enabled` and `disabled`, with an optional `budget_tokens`, are taken as
 * before. Any other type or inner key is refused by name. Thinking bills as output within `max_tokens`, which the
 * broker rewrites and reserves in full, so the worst case covers it unchanged.
 */
function thinkingRefusal(t: unknown): string | null {
  if (!isObj(t)) return "thinking";
  if (t.type === "adaptive") {
    const extra = Object.keys(t).find((k) => k !== "type" && k !== "display");
    if (extra !== undefined) return `thinking_key:${nameCode(extra)}`;
    if (t.display !== undefined && !(typeof t.display === "string" && THINKING_DISPLAYS.includes(t.display))) return "thinking:display";
    return null;
  }
  if (t.type === "enabled" || t.type === "disabled") {
    const extra = Object.keys(t).find((k) => k !== "type" && k !== "budget_tokens");
    return extra === undefined ? null : `thinking_key:${nameCode(extra)}`;
  }
  return `thinking:${nameCode(t.type)}`;
}

/** The request body, by the allowlist: the first part refused, as a code, or null when the body is allowed. */
function bodyRefusal(b: Obj): string | null {
  const extra = Object.keys(b).find((k) => !TOP_KEYS.includes(k));
  if (extra !== undefined) return `top_key:${nameCode(extra)}`;
  // Top-level automatic caching, exactly `{ type: "ephemeral" }`, no lifetime (the third reviewed widening). The worst
  // case already prices every input byte at the dearest input-side rate, a cache write's included.
  if (b.cache_control !== undefined && !(isObj(b.cache_control) && only(b.cache_control, ["type"]) && b.cache_control.type === "ephemeral")) return "cache_control";
  if (b.output_config !== undefined) {
    const refused = outputConfigRefusal(b.output_config);
    if (refused !== null) return refused;
  }
  if (!Array.isArray(b.messages)) return "messages";
  for (const m of b.messages) {
    if (!isObj(m)) return "message_shape";
    const key = Object.keys(m).find((k) => k !== "role" && k !== "content");
    if (key !== undefined) return `message_key:${nameCode(key)}`;
    if (m.role !== "user" && m.role !== "assistant" && m.role !== "system") return `message_role:${nameCode(m.role)}`;
    if (isText(m.content)) continue;
    if (!Array.isArray(m.content)) return "message_content";
    if (m.role === "system") {
      const refused = systemMessageRefusal(m.content);
      if (refused !== null) return refused;
      continue;
    }
    for (const block of m.content) {
      const refused = blockRefusal(block);
      if (refused) return refused;
    }
  }
  if (!optional(b.system, (v) => isText(v) || (Array.isArray(v) && v.every((x) => isObj(x) && x.type === "text" && blockOk(x))))) return "system";
  if (b.tools !== undefined) {
    if (!Array.isArray(b.tools)) return "tools";
    for (const t of b.tools) {
      if (!isObj(t)) return "tools";
      const key = Object.keys(t).find((k) => !TOOL_KEYS.includes(k));
      if (key !== undefined) return `tool_key:${nameCode(key)}`;
      if (t.type !== undefined && t.type !== "custom") return `tool_type:${nameCode(t.type)}`;
      if (!optional(t.eager_input_streaming, (e) => typeof e === "boolean")) return "tool:eager_input_streaming";
      if (!toolOk(t)) return "tool_shape";
    }
  }
  if (!optional(b.tool_choice, (v) => isObj(v) && only(v, ["type", "name", "disable_parallel_tool_use"]) && ["auto", "any", "tool", "none"].includes(v.type as string))) return "tool_choice";
  if (b.thinking !== undefined) {
    const refused = thinkingRefusal(b.thinking);
    if (refused !== null) return refused;
  }
  if (!optional(b.metadata, (v) => isObj(v) && only(v, ["user_id"]))) return "metadata";
  if (!optional(b.stop_sequences, (v) => Array.isArray(v) && v.every(isText))) return "stop_sequences";
  if (!optional(b.stream, (v) => typeof v === "boolean")) return "stream";
  for (const k of ["temperature", "top_k", "top_p"]) if (!optional(b[k], (v) => typeof v === "number" && Number.isFinite(v))) return k;
  return null;
}

// ---- The OpenAI Responses dialect (RUNNER-OPENAI.md, "The broker profile"; built 2026-11-22, off by default) ----
//
// - Only a known body: top-level keys from `RESPONSES_ALLOWED_KEYS`; every key in `RESPONSES_REFUSED_KEYS` refused by
//   name, and any other key too. Tools only `type: "function"`; every hosted tool refused by its type. Input items only
//   user and assistant text messages, function calls, text function outputs and reasoning items: no system or developer
//   role, no image, file or audio, no item reference. `truncation` only `disabled`; `include` only encrypted reasoning.
// - Forced keys: `admit` writes `store: false` and its own `max_output_tokens` after parsing.
// - Usage is read nested (spike M7-OpenAI, 2026-11-21, on all 23 requests that returned usage): cached and cache-write
//   tokens are parts of `input_tokens`, and reasoning tokens part of `output_tokens`. A usage missing a field, or whose
//   parts are larger than their whole, can't be read, so the request counts its worst case. A 12-hour cache write above
//   zero is `unexpected`: the request counts its worst case and the run stops (`usage_unexpected`).

/**
 * The reasoning headroom floor (2026-11-22): an OpenAI request's output bound is never below this, since
 * `max_output_tokens` bounds reasoning and visible output together and spike M7-OpenAI's 256-token bound was spent
 * entirely on reasoning. Equal to `OPENAI_MIN_MAX_TOKENS` in `policy.ts`, which refuses a lower cap at load (a test holds
 * the two equal; neither pure module imports the other).
 */
export const OPENAI_MIN_OUTPUT_BOUND = 4_096;

const isStr = (v: unknown): v is string => typeof v === "string";
const extraKey = (o: Obj, keys: readonly string[]) => Object.keys(o).find((k) => !keys.includes(k));

/** Top-level keys the broker takes (`openai` 7.62.0's `ResponseCreateParamsBase`, read 2026-11-21). */
export const RESPONSES_ALLOWED_KEYS: readonly string[] = Object.freeze(["model", "input", "instructions", "tools", "tool_choice", "parallel_tool_calls", "max_output_tokens", "store", "stream", "include", "reasoning", "text", "temperature", "top_p", "truncation"]);

/** Keys refused by name: work, state or spend outside Runner's tools and its worst case. */
export const RESPONSES_REFUSED_KEYS: readonly string[] = Object.freeze([
  "background", "background_options", "conversation", "previous_response_id", "prompt", "context_management",
  "prompt_cache_options", "prompt_cache_retention", "prompt_cache_key", "service_tier", "max_tool_calls", "metadata",
  "safety_identifier", "user", "moderation", "access_programs", "image", "top_logprobs", "stream_options",
]);

/** Hosted tool types, refused by type. Only `function` passes; an unlisted type is refused too. */
export const HOSTED_TOOL_TYPES: readonly string[] = Object.freeze([
  "web_search", "web_search_preview", "web_search_2025_08_26", "web_search_preview_2025_03_11", "file_search",
  "code_interpreter", "computer", "computer_use_preview", "computer_use", "mcp", "shell", "local_shell", "apply_patch",
  "image_generation", "programmatic_tool_calling", "tool_search", "custom", "namespace",
]);

/** Reasoning efforts reviewed for the worst case: all reasoning counts inside `max_output_tokens`. */
const REASONING_EFFORTS = ["minimal", "low", "medium"];
const REASONING_SUMMARIES = ["none", "auto"];
const VERBOSITIES = ["low", "medium", "high"];

const ITEM_KEYS: Readonly<Record<string, readonly string[]>> = {
  message: ["type", "id", "role", "status", "content"],
  function_call: ["type", "id", "call_id", "name", "arguments", "status"],
  function_call_output: ["type", "id", "call_id", "output", "status"],
  reasoning: ["type", "id", "summary", "encrypted_content", "content", "status"],
};
const TEXT_PART_KEYS = ["type", "text", "annotations", "logprobs"];
const RESPONSES_TOOL_KEYS = ["type", "name", "description", "parameters", "strict"];

/** A message's content: a string, or text parts of the given types only. */
function textPartsRefusal(content: unknown, types: readonly string[], at: string): string | null {
  if (isStr(content)) return null;
  if (!Array.isArray(content)) return `${at}_content`;
  for (const part of content) {
    if (!isObj(part) || !isStr(part.type) || !types.includes(part.type)) return `${at}_part:${nameCode(isObj(part) ? part.type : undefined)}`;
    const extra = extraKey(part, TEXT_PART_KEYS);
    if (extra !== undefined) return `${at}_part_key:${nameCode(extra)}`;
    if (!isStr(part.text)) return `${at}_part_shape`;
    if (part.annotations !== undefined && !(Array.isArray(part.annotations) && part.annotations.length === 0)) return `${at}_part:annotations`;
  }
  return null;
}

function inputRefusal(input: unknown, tools: ReadonlySet<string>): string | null {
  if (isStr(input)) return null;
  if (!Array.isArray(input)) return "input";
  for (const item of input) {
    if (!isObj(item)) return "input_item";
    const type = item.type ?? (item.role !== undefined ? "message" : undefined);
    if (typeof type !== "string" || !Object.hasOwn(ITEM_KEYS, type)) return `input_type:${nameCode(type)}`;
    const extra = extraKey(item, ITEM_KEYS[type]);
    if (extra !== undefined) return `input_key:${type}.${nameCode(extra)}`;
    if (type === "message") {
      if (item.role !== "user" && item.role !== "assistant") return `input_role:${nameCode(item.role)}`;
      const refused = textPartsRefusal(item.content, item.role === "user" ? ["input_text"] : ["output_text"], "input_message");
      if (refused !== null) return refused;
    } else if (type === "function_call") {
      if (!isStr(item.name) || !tools.has(item.name)) return "input_function_call:name";
      if (!isStr(item.arguments) || !isStr(item.call_id)) return "input_function_call:shape";
    } else if (type === "function_call_output") {
      if (!isStr(item.call_id)) return "input_function_call_output:shape";
      if (!isStr(item.output)) {
        const refused = textPartsRefusal(item.output, ["input_text"], "input_function_call_output");
        if (refused !== null) return refused;
      }
    } else {
      if (item.encrypted_content !== undefined && item.encrypted_content !== null && !isStr(item.encrypted_content)) return "input_reasoning:encrypted_content";
      if (item.content !== undefined && !(Array.isArray(item.content) && item.content.length === 0)) return "input_reasoning:content";
      if (item.summary !== undefined && !(Array.isArray(item.summary) && item.summary.every((s) => isObj(s) && s.type === "summary_text" && isStr(s.text) && extraKey(s, ["type", "text"]) === undefined))) return "input_reasoning:summary";
    }
  }
  return null;
}

/** The tools' names, or the first part refused. */
function toolsRefusal(tools: unknown): { names: Set<string> } | { refused: string } {
  if (!Array.isArray(tools)) return { refused: "tools" };
  const names = new Set<string>();
  for (const t of tools) {
    if (!isObj(t)) return { refused: "tools" };
    if (t.type !== "function") return { refused: `tool_type:${nameCode(t.type)}` };
    const extra = extraKey(t, RESPONSES_TOOL_KEYS);
    if (extra !== undefined) return { refused: `tool_key:${nameCode(extra)}` };
    if (!isStr(t.name) || !/^[A-Za-z0-9_-]{1,64}$/.test(t.name) || !isObj(t.parameters) || (t.description !== undefined && t.description !== null && !isStr(t.description)) || (t.strict !== undefined && t.strict !== null && typeof t.strict !== "boolean")) return { refused: "tool_shape" };
    names.add(t.name);
  }
  return { names };
}

/** The request body, by the allowlist: the first part refused, as a code, or null when the body is allowed. */
export function responsesBodyRefusal(b: Obj): string | null {
  for (const key of Object.keys(b)) {
    if (RESPONSES_REFUSED_KEYS.includes(key)) return `refused_key:${key}`;
    if (!RESPONSES_ALLOWED_KEYS.includes(key)) return `top_key:${nameCode(key)}`;
  }
  if (b.instructions !== undefined && b.instructions !== null && !isStr(b.instructions)) return "instructions";
  const tools = toolsRefusal(b.tools ?? []);
  if ("refused" in tools) return tools.refused;
  if (b.tool_choice !== undefined && b.tool_choice !== null) {
    const c = b.tool_choice;
    const named = isObj(c) && c.type === "function" && isStr(c.name) && tools.names.has(c.name) && extraKey(c, ["type", "name"]) === undefined;
    if (!named && c !== "auto" && c !== "required" && c !== "none") return "tool_choice";
  }
  const input = inputRefusal(b.input, tools.names);
  if (input !== null) return input;
  for (const k of ["parallel_tool_calls", "stream", "store"]) if (b[k] !== undefined && b[k] !== null && typeof b[k] !== "boolean") return k;
  if (b.include !== undefined && b.include !== null && !(Array.isArray(b.include) && b.include.every((x) => x === "reasoning.encrypted_content"))) return "include";
  if (b.reasoning !== undefined && b.reasoning !== null) {
    const r = b.reasoning;
    if (!isObj(r)) return "reasoning";
    const extra = extraKey(r, ["effort", "summary"]);
    if (extra !== undefined) return `reasoning_key:${nameCode(extra)}`;
    if (r.effort !== undefined && r.effort !== null && !(isStr(r.effort) && REASONING_EFFORTS.includes(r.effort))) return "reasoning:effort";
    if (r.summary !== undefined && r.summary !== null && !(isStr(r.summary) && REASONING_SUMMARIES.includes(r.summary))) return "reasoning:summary";
  }
  if (b.text !== undefined && b.text !== null) {
    const t = b.text;
    if (!isObj(t)) return "text";
    const extra = extraKey(t, ["format", "verbosity"]);
    if (extra !== undefined) return `text_key:${nameCode(extra)}`;
    if (t.verbosity !== undefined && t.verbosity !== null && !(isStr(t.verbosity) && VERBOSITIES.includes(t.verbosity))) return "text:verbosity";
    if (t.format !== undefined && t.format !== null) {
      const f = t.format;
      if (!isObj(f)) return "text:format";
      if (f.type === "text") {
        if (extraKey(f, ["type"]) !== undefined) return "text:format";
      } else if (f.type === "json_schema") {
        if (extraKey(f, ["type", "name", "schema", "strict", "description"]) !== undefined || !isStr(f.name) || !isObj(f.schema)) return "text:format";
      } else return `text_format:${nameCode(f.type)}`;
    }
  }
  for (const k of ["temperature", "top_p"]) if (b[k] !== undefined && b[k] !== null && !(typeof b[k] === "number" && Number.isFinite(b[k]))) return k;
  if (b.truncation !== undefined && b.truncation !== null && b.truncation !== "disabled") return "truncation";
  if (b.max_output_tokens !== undefined && b.max_output_tokens !== null && !(isCount(b.max_output_tokens) && b.max_output_tokens > 0)) return "max_output_tokens";
  return null;
}

/** A Responses usage, read nested: `{ usage }` in the broker's own fields, `unexpected` for a 12-hour cache write, or null. */
export function readResponsesUsage(v: unknown): { usage: Usage } | { unexpected: true } | null {
  if (!isObj(v)) return null;
  const inDetails = v.input_tokens_details;
  const outDetails = v.output_tokens_details;
  if (!isObj(inDetails) || !isObj(outDetails)) return null;
  const writeDetails = inDetails.cache_write_tokens_details;
  if (isObj(writeDetails) && writeDetails.ttl_12h_tokens !== undefined && writeDetails.ttl_12h_tokens !== null) {
    if (!isCount(writeDetails.ttl_12h_tokens)) return null;
    if (writeDetails.ttl_12h_tokens > 0) return { unexpected: true };
  }
  const input = v.input_tokens;
  const output = v.output_tokens;
  const cached = inDetails.cached_tokens;
  const written = inDetails.cache_write_tokens;
  const reasoning = outDetails.reasoning_tokens;
  if (!isCount(input) || !isCount(output) || !isCount(cached) || !isCount(written) || !isCount(reasoning)) return null;
  // Nested: the parts can't be larger than their whole. If they are, the reading is wrong, so it counts the worst case.
  if (cached + written > input || reasoning > output) return null;
  return { usage: { input_tokens: input - cached - written, cache_read_input_tokens: cached, cache_creation_input_tokens: written, output_tokens: output } };
}

type InFlight = { worst: number; max_tokens: number; price: Price };
/** Each dialect's output-bound key. */
const BOUND_KEY: Record<Dialect, string> = { anthropic_messages: "max_tokens", openai_responses: "max_output_tokens" };

/** One run's broker: its caps, its allowed models, and its running total. */
export class RunBroker {
  private readonly profile: ProviderProfile;
  private readonly caps: BrokerCaps;
  private readonly models: ReadonlySet<string>;
  private readonly url: string;
  private readonly dialect: Dialect;
  private unexpected = false;
  private spent = 0;
  private outputUsed = 0;
  private turns = 0;
  private next = 0;
  private closed = false;
  private readonly inFlight = new Map<string, InFlight>();

  constructor(profile: ProviderProfile, caps: BrokerCaps, models: readonly string[]) {
    this.url = upstreamUrl(profile);
    if (!isCap(caps.spend_micro_usd) || !isCap(caps.turns) || !isCap(caps.output_tokens) || !isCap(caps.max_tokens)) throw new Error("a run's caps must each be set, as a positive whole number");
    for (const model of models) if (!Object.hasOwn(profile.prices, model)) throw new Error("a run's model has no price in the provider profile, so Runner won't allow it");
    this.dialect = dialectOf(profile);
    if (this.dialect === "openai_responses" && caps.max_tokens < OPENAI_MIN_OUTPUT_BOUND) throw new Error("an OpenAI run's max_tokens cap is below the reasoning headroom floor");
    this.profile = profile;
    this.caps = { ...caps };
    this.models = new Set(models);
  }

  /** Spend counted so far, with every request in flight at its worst case; turns; output tokens; requests in flight. */
  get totals(): { spent_micro_usd: number; turns: number; output_tokens: number; in_flight: number } {
    let held = 0;
    for (const f of this.inFlight.values()) held += f.worst;
    return { spent_micro_usd: this.spent + held, turns: this.turns, output_tokens: this.outputUsed, in_flight: this.inFlight.size };
  }

  /** Refuses every later request. Requests in flight still settle, or count their worst case. */
  close() {
    this.closed = true;
  }

  admit(request: BrokerRequest): Admission {
    const refuse = (reason: BrokerRefusal): Admission => ({ ok: false, reason, hard_stop: HARD.has(reason) });
    if (this.closed) return refuse("run_stopped");
    if (request.method !== "POST") return refuse("method_not_allowed");
    if (request.path !== this.profile.path) return refuse("path_not_allowed");
    if (request.query !== "") return refuse("query_not_allowed");
    if (request.body.byteLength > MAX_BODY_BYTES) return refuse("body_too_large");
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(request.body));
    } catch {
      return refuse("body_invalid");
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) return refuse("body_invalid");
    const fields = body as Record<string, unknown>;
    const model = fields.model;
    if (typeof model !== "string") return refuse("body_invalid");
    if (!Object.hasOwn(this.profile.prices, model)) return refuse("model_unpriced");
    if (!this.models.has(model)) return refuse("model_not_allowed");
    const openai = this.dialect === "openai_responses";
    const refusedPart = openai ? responsesBodyRefusal(fields) : bodyRefusal(fields);
    if (refusedPart !== null) return { ok: false, reason: "body_not_allowed", hard_stop: false, detail: refusedPart };

    if (this.turns >= this.caps.turns) return refuse("turns_exhausted");
    let heldOutput = 0;
    let heldSpend = 0;
    for (const f of this.inFlight.values()) {
      heldOutput += f.max_tokens;
      heldSpend += f.worst;
    }
    const outputLeft = this.caps.output_tokens - this.outputUsed - heldOutput;
    const boundKey = BOUND_KEY[this.dialect];
    const asked = fields[boundKey];
    // The reasoning headroom rule: an OpenAI request may not ask for less than the floor, since reasoning counts inside it.
    if (openai && isCap(asked) && asked < OPENAI_MIN_OUTPUT_BOUND) return { ok: false, reason: "body_not_allowed", hard_stop: false, detail: "max_output_tokens:below_floor" };
    const bound = Math.min(this.caps.max_tokens, outputLeft, isCap(asked) ? asked : Number.POSITIVE_INFINITY);
    if (bound <= 0 || (openai && bound < OPENAI_MIN_OUTPUT_BOUND)) return refuse("output_tokens_exhausted");

    // Parsed and written again, so a duplicate key can't carry another value past the rewrite; `store` forced off for OpenAI.
    const rewritten = new TextEncoder().encode(JSON.stringify(openai ? { ...fields, [boundKey]: bound, store: false } : { ...fields, max_tokens: bound }));
    const worst = worstCaseOf(this.profile.prices[model], rewritten.byteLength, bound);
    if (this.spent + heldSpend + worst > this.caps.spend_micro_usd) return refuse("spend_cap");

    const request_id = `req_${++this.next}`;
    this.turns++;
    this.inFlight.set(request_id, { worst, max_tokens: bound, price: this.profile.prices[model] });
    return { ok: true, forward: { request_id, url: this.url, headers: { ...this.profile.headers }, body: rewritten, max_tokens: bound, worst_micro_usd: worst } };
  }

  /**
   * Counts what a forwarded request cost, from the provider's usage, and says whether a cap is now reached. Usage that
   * can't be read counts the request's worst case. A request the broker didn't admit, or already counted, changes nothing.
   */
  settle(request_id: string, usage: unknown): { cap_reached: HardStop | null } {
    const held = this.inFlight.get(request_id);
    if (!held) return { cap_reached: this.reached() };
    this.inFlight.delete(request_id);
    let read: Usage | null;
    if (this.dialect === "openai_responses") {
      const nested = readResponsesUsage(usage);
      if (nested !== null && "unexpected" in nested) this.unexpected = true;
      read = nested !== null && "usage" in nested ? nested.usage : null;
    } else {
      read = usageOf(usage);
    }
    if (read) {
      this.spent += costOf(held.price, read);
      this.outputUsed += read.output_tokens;
    } else {
      this.spent += held.worst;
      this.outputUsed += held.max_tokens;
    }
    return { cap_reached: this.reached() };
  }

  /** A request whose usage never arrived (cut, failed or lost): its whole worst case counts. */
  fail(request_id: string) {
    const held = this.inFlight.get(request_id);
    if (!held) return;
    this.inFlight.delete(request_id);
    this.spent += held.worst;
    this.outputUsed += held.max_tokens;
  }

  private reached(): HardStop | null {
    if (this.unexpected) return "usage_unexpected";
    if (this.spent >= this.caps.spend_micro_usd) return "spend_cap";
    if (this.outputUsed >= this.caps.output_tokens) return "output_tokens_exhausted";
    return null;
  }
}
