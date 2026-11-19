/**
 * The Claude driver's provider profile (M7 step 9(b); the architect's rulings 2, 3 and 6 on spike B). Fixed here in code,
 * never read from configuration, the task or anything Podster sends:
 *
 * - **One upstream:** the profile's host and path, built by the broker from these parts alone. This file is
 *   the only one in Runner's source that may name the provider's versioned path, and only as the exact literal below
 *   (the scoped source test in `test/machine.test.ts`).
 * - **No beta header:** the broker refuses a profile whose fixed headers carry one, and the listener forwards none.
 * - **A price for every model it may ask for:** a model with no price is refused, never counted as free (ruling 3).
 *   Only `claude-haiku-5-5`, the model spike B ran; a larger model joins only after S-49's recheck.
 * - **The pinned pair:** the Claude Agent SDK and the Claude Code it bundles, exactly. Any other version is refused at
 *   Runner's start and again on each run's first message (S-48).
 *
 * Pure: no I/O.
 */
import type { Price, ProviderProfile } from "./broker.js";

/** The SDK and its bundled Claude Code, as spike B ran them. A new pair is admitted only after spike B's checks pass on it. */
export const PINNED_SDK_VERSION = "0.3.327";
export const PINNED_CLAUDE_CODE_VERSION = "2.1.327";

/** The model Runner asks for. */
export const CLAUDE_MODEL = "claude-haiku-5-5";

/**
 * Micro-USD per million tokens. Input and output are Anthropic's list prices for Claude Haiku 5.5 (0.10 and 0.50 USD per
 * million, read 2026-11-18 from the claude-api reference cached 2026-11-03, for prompts up to 100K tokens). Cache writes
 * and reads are taken at 1.25 and 0.1 times input, as spike B assumed and the SDK's figures matched. Above 100K input
 * tokens the list price rises; the broker's worst case and caps bound a run long before that matters, and S-49 rechecks it.
 */
const HAIKU_5_5: Price = { input: 100_000, output: 500_000, cache_write: 125_000, cache_read: 10_000 };

export const CLAUDE_PROFILE: ProviderProfile = Object.freeze({
  provider: "anthropic",
  host: "api.anthropic.com",
  path: "/v1/messages",
  headers: Object.freeze({ "anthropic-version": "2023-06-01", "content-type": "application/json" }) as Record<string, string>,
  prices: Object.freeze({ [CLAUDE_MODEL]: Object.freeze({ ...HAIKU_5_5 }) }) as Record<string, Price>,
});

export const CLAUDE_MODELS: readonly string[] = Object.freeze([CLAUDE_MODEL]);

/** Why the installed pair can't run, or null when it is exactly the pinned one. */
export function versionRefusal(found: { sdk: unknown; claude_code: unknown }): "sdk_version" | "claude_code_version" | null {
  if (found.sdk !== PINNED_SDK_VERSION) return "sdk_version";
  if (found.claude_code !== PINNED_CLAUDE_CODE_VERSION) return "claude_code_version";
  return null;
}
