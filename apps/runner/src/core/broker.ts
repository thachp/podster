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
 * - **Only a known body** (M1 on #459): known top-level keys, `output_config` and adaptive `thinking` only in their
 *   reviewed shapes; tools only the driver's own (`custom`), never the
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
 */

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

/** Refusals that end the run. */
export type HardStop = "turns_exhausted" | "output_tokens_exhausted" | "spend_cap";
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

function checkProfile(profile: ProviderProfile) {
  if (Object.keys(profile.headers).some((name) => name.toLowerCase() === "anthropic-beta")) throw new Error("the provider profile's fixed headers may not turn on a beta");
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

const TOP_KEYS = ["model", "messages", "max_tokens", "system", "metadata", "stop_sequences", "stream", "temperature", "top_k", "top_p", "tools", "tool_choice", "thinking", "output_config"];

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

function toolOk(v: unknown): boolean {
  if (!isObj(v) || !only(v, ["type", "name", "description", "input_schema", "cache_control"])) return false;
  return (v.type === undefined || v.type === "custom") && isText(v.name) && optional(v.description, isText) && isObj(v.input_schema) && cacheOk(v.cache_control);
}

/** A name from the request as a code: itself if it's a plain identifier, else `other`. */
const nameCode = (v: unknown) => (typeof v === "string" && /^[a-z][a-z0-9_]{0,39}$/.test(v) ? v : "other");

/** The first part of a content block outside the allowlist, as a code; null when the block is allowed. */
function blockRefusal(v: unknown, inResult = false): string | null {
  if (blockOk(v, inResult)) return null;
  if (!isObj(v)) return "block:other";
  const known = ["text", "image", "document", "tool_use", "tool_result", "thinking", "redacted_thinking"];
  if (typeof v.type !== "string" || !known.includes(v.type)) return `block:${nameCode(v.type)}`;
  if (!cacheOk(v.cache_control)) return "cache_control";
  return `block_shape:${v.type}`;
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
  if (b.output_config !== undefined) {
    const refused = outputConfigRefusal(b.output_config);
    if (refused !== null) return refused;
  }
  if (!Array.isArray(b.messages)) return "messages";
  for (const m of b.messages) {
    if (!isObj(m) || !only(m, ["role", "content"]) || (m.role !== "user" && m.role !== "assistant")) return "message_shape";
    if (isText(m.content)) continue;
    if (!Array.isArray(m.content)) return "message_shape";
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
      const key = Object.keys(t).find((k) => !["type", "name", "description", "input_schema", "cache_control"].includes(k));
      if (key !== undefined) return `tool_key:${nameCode(key)}`;
      if (t.type !== undefined && t.type !== "custom") return `tool_type:${nameCode(t.type)}`;
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

type InFlight = { worst: number; max_tokens: number; price: Price };

/** One run's broker: its caps, its allowed models, and its running total. */
export class RunBroker {
  private readonly profile: ProviderProfile;
  private readonly caps: BrokerCaps;
  private readonly models: ReadonlySet<string>;
  private readonly url: string;
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
    const refusedPart = bodyRefusal(fields);
    if (refusedPart !== null) return { ok: false, reason: "body_not_allowed", hard_stop: false, detail: refusedPart };

    if (this.turns >= this.caps.turns) return refuse("turns_exhausted");
    let heldOutput = 0;
    let heldSpend = 0;
    for (const f of this.inFlight.values()) {
      heldOutput += f.max_tokens;
      heldSpend += f.worst;
    }
    const outputLeft = this.caps.output_tokens - this.outputUsed - heldOutput;
    const asked = fields.max_tokens;
    const bound = Math.min(this.caps.max_tokens, outputLeft, isCap(asked) ? asked : Number.POSITIVE_INFINITY);
    if (bound <= 0) return refuse("output_tokens_exhausted");

    const rewritten = new TextEncoder().encode(JSON.stringify({ ...fields, max_tokens: bound }));
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
    const read = usageOf(usage);
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
    if (this.spent >= this.caps.spend_micro_usd) return "spend_cap";
    if (this.outputUsed >= this.caps.output_tokens) return "output_tokens_exhausted";
    return null;
  }
}
