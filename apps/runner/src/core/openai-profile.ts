/**
 * The OpenAI Agents SDK driver's provider profile (RUNNER-OPENAI.md; built 2026-11-22, off by default, not verified for
 * support). Fixed here in code, never read from configuration, the task or anything Podster sends:
 *
 * - **One upstream:** OpenAI's Responses API, the profile's host and path. This file is the only one in Runner's source
 *   that may name that versioned path, and only as the exact literal below (the scoped source test in
 *   `test/machine.test.ts`). The driver derives its client's base URL and the one request URL it accepts from here.
 * - **The Responses dialect:** the broker checks bodies against the Responses dialect in `broker.ts`, forces `store: false`, rewrites
 *   `max_output_tokens`, and reads usage nested (spike M7-OpenAI, 2026-11-21).
 * - **No beta, organization or project header,** and no authorization: the transport adds `Bearer <key>` last.
 * - **A price for its one model,** `gpt-6-luna`. A larger model joins only by a reviewed profile entry.
 * - **The pinned packages:** `@openai/agents-core`, `@openai/agents-openai` and `openai`, exactly. Any other installed
 *   version is refused at Runner's start (S-58).
 *
 * Pure: no I/O.
 */
import { upstreamUrl, type Price, type ProviderProfile } from "./broker.js";

/** Exact pins, as spike M7-OpenAI ran them on 2026-11-21. A new pin is admitted only after the spike's checks pass on it. */
export const PINNED_OPENAI_PACKAGES: Readonly<Record<string, string>> = Object.freeze({
  "@openai/agents-core": "0.22.0",
  "@openai/agents-openai": "0.22.0",
  openai: "7.62.0",
});

/** The one model Runner asks OpenAI for (the architect's answer to question 5, 2026-11-21). */
export const OPENAI_MODEL = "gpt-6-luna";

/** The reasoning effort the driver fixes for every request: what spike M7-OpenAI ran with `store: false`. */
export const OPENAI_REASONING_EFFORT = "low";

/**
 * Micro-USD per million tokens, Standard tier, from OpenAI's pricing page
 * (https://developers.openai.com/api/docs/pricing), first read 2026-11-21 and rechecked 2026-11-22 against the figures
 * RUNNER-OPENAI.md records (the page shows no as-of date). `cache_write` is the 30-minute write; 12-hour writes are never
 * priced, since the broker refuses the keys that ask for them and a usage reporting one stops the run
 * (`usage_unexpected`). Above 272K input tokens the long-context tier applies to the whole request.
 */
const GPT_6_LUNA: Price = {
  input: 100_000,
  output: 500_000,
  cache_write: 125_000,
  cache_read: 10_000,
  long_context: { above_input_tokens: 272_000, input: 200_000, output: 750_000, cache_write: 250_000, cache_read: 20_000 },
};

export const OPENAI_PROFILE: ProviderProfile = Object.freeze({
  provider: "openai",
  dialect: "openai_responses",
  host: "api.openai.com",
  path: "/v1/responses",
  headers: Object.freeze({ "content-type": "application/json" }) as Record<string, string>,
  prices: Object.freeze({ [OPENAI_MODEL]: Object.freeze({ ...GPT_6_LUNA, long_context: Object.freeze({ ...(GPT_6_LUNA.long_context as NonNullable<Price["long_context"]>) }) }) }) as Record<string, Price>,
});

export const OPENAI_MODELS: readonly string[] = Object.freeze([OPENAI_MODEL]);

/** The OpenAI client's base URL: the profile's upstream without its last path segment, which the client appends. */
export function openaiBaseUrl(profile: ProviderProfile = OPENAI_PROFILE): string {
  const url = upstreamUrl(profile);
  return url.slice(0, url.lastIndexOf("/"));
}

/** Why the installed packages can't run, as a fixed code naming the package, or null when each is exactly the pin. */
export function openaiVersionRefusal(found: Readonly<Record<string, unknown>>): string | null {
  for (const [name, version] of Object.entries(PINNED_OPENAI_PACKAGES)) if (!Object.hasOwn(found, name) || found[name] !== version) return `version:${name}`;
  return null;
}

/**
 * Environment names OpenAI's packages read as defaults that could point the SDK elsewhere, give it a key, or turn
 * logging on: every `OPENAI_` name but the three that only switch things off. Runner refuses to start the OpenAI
 * adapter with any of them set (S-54), and `ANTHROPIC_API_KEY` too, since no provider key belongs in Runner's own
 * environment: it is read only from the key file.
 */
export const OPENAI_ENV_ALLOWED: readonly string[] = Object.freeze(["OPENAI_AGENTS_DISABLE_TRACING", "OPENAI_AGENTS_DONT_LOG_MODEL_DATA", "OPENAI_AGENTS_DONT_LOG_TOOL_DATA"]);

/** The refused names found in `env`, sorted. Values are never read. */
export function openaiEnvRefusals(env: Readonly<Record<string, string | undefined>>): string[] {
  return Object.keys(env)
    .filter((name) => (/^OPENAI_/i.test(name) && !OPENAI_ENV_ALLOWED.includes(name)) || /^ANTHROPIC_(API_KEY|AUTH_TOKEN|BASE_URL)$/i.test(name))
    .sort();
}

/** The fixed warning `run` prints when the OpenAI adapter starts. */
export const OPENAI_WARNING =
  "Warning: this Runner uses the experimental OpenAI adapter. Room content (task text, file contents and tool output) goes to OpenAI under OpenAI's standard data retention, with store: false. Use test content only. This adapter is not verified for support.";
