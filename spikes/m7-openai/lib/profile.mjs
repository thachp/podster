// The spike's provider profile for OpenAI's Responses API, fixed in code and never read from configuration
// (RUNNER-OPENAI.md, "The broker profile"). This file is the only one in the spike that names the upstream
// host and path. Pure: no I/O.

/** Exact pins (S-58). Any other installed version is refused before a run. */
export const PINNED = Object.freeze({
  "@openai/agents-core": "0.22.0",
  "@openai/agents-openai": "0.22.0",
  openai: "7.62.0",
});

/** The one model the spike may ask for (the architect's answer to question 5). */
export const OPENAI_MODEL = "gpt-6-luna";

/**
 * Micro-USD per million tokens, Standard tier, from OpenAI's pricing page as RUNNER-OPENAI.md records it
 * (read 2026-11-21). `cache_write` is the 30-minute write; 12-hour writes are never priced.
 */
const GPT_6_LUNA = Object.freeze({
  input: 100_000,
  cache_read: 10_000,
  cache_write: 125_000,
  output: 500_000,
  long_context: Object.freeze({ above_input_tokens: 272_000, input: 200_000, cache_read: 20_000, cache_write: 250_000, output: 750_000 }),
});

export const OPENAI_PROFILE = Object.freeze({
  provider: "openai",
  dialect: "openai_responses",
  host: "api.openai.com",
  path: "/v1/responses",
  headers: Object.freeze({ "content-type": "application/json" }),
  prices: Object.freeze({ [OPENAI_MODEL]: GPT_6_LUNA }),
});

/** Headers a profile may never fix: auth is the transport's alone, and no beta, organization or project header. */
const FORBIDDEN_FIXED_HEADERS = ["authorization", "openai-beta", "openai-organization", "openai-project", "x-api-key"];

/** Why a profile can't be used, or null. */
export function profileRefusal(profile) {
  for (const name of Object.keys(profile.headers)) {
    if (FORBIDDEN_FIXED_HEADERS.includes(name.toLowerCase())) return `fixed_header:${name.toLowerCase()}`;
  }
  if (!/^[a-z0-9.-]+$/.test(profile.host)) return "host";
  if (!/^\/[a-z0-9/]+$/.test(profile.path) || profile.path.includes("//")) return "path";
  return null;
}

/** The one upstream URL, built from the profile's fixed parts only. */
export function upstreamUrl(profile) {
  return `https://${profile.host}${profile.path}`;
}

/** The OpenAI client's base URL: the upstream without its last path segment (the client appends `/responses`). */
export function baseUrlOf(profile) {
  return `https://${profile.host}${profile.path.slice(0, profile.path.lastIndexOf("/"))}`;
}

/** Why the installed packages can't run, or null when each is exactly pinned. */
export function versionRefusal(found) {
  for (const [name, version] of Object.entries(PINNED)) {
    if (found?.[name] !== version) return `version:${name}`;
  }
  return null;
}

/**
 * The spike's caps (RUNNER-OPENAI.md, "Spike plan"; the owner approved 2.00 USD in total on 2026-11-21).
 * `turns`, `output_tokens` and `max_tokens` are the spike's choices, well inside the spend cap.
 */
export const RUN_CAPS = Object.freeze({ spend_micro_usd: 200_000, turns: 20, output_tokens: 60_000, max_tokens: 4_096 });
export const DAY_CAP_MICRO_USD = 2_000_000;
export const TOTAL_CAP_MICRO_USD = 2_000_000;
