// The limits set on every dispatch to an app whose release carries code (ADR 0010's proposed revision, sections 3.4,
// 5 and 10: "limits on every invocation", "a test shows an app that spins is stopped"). The platform stops a script
// that passes either at once, and the content Worker answers that as its own error, `502 app_error`
// ([custom limits](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/custom-limits/)).
//
// **The figures aren't named here.** ADR 0010's revision says they wait for a spike, and no spike or ruling has set
// them. Both come from two settings, read by `limitsFromSettings`, with no constant, no default and no fallback: a
// missing or malformed setting is no limits, and **every request to a host with code is refused `503 app_limits_unknown`
// before its app is asked,** so no app's code ever runs without them. A static host's script runs no code of an app's
// and is dispatched as before, with none.

/** The limits one dispatch is given, in the dispatch namespace's own words. */
export interface DispatchLimits {
  /** CPU time, in milliseconds: at least one. */
  readonly cpuMs: number;
  /** Subrequests, the outbound Worker's refusals among them: none or more. */
  readonly subRequests: number;
}

/** A whole number written as a setting is: decimal digits only, with no sign, space or leading zero, under a billion. */
const DECIMAL = /^(?:0|[1-9][0-9]{0,8})$/;

/**
 * The limits, from their two settings, each a decimal string: CPU milliseconds, at least one, and subrequests, none or
 * more. Null, so every request to a host with code is refused, if either is missing, isn't a string or isn't written
 * exactly so, or if the CPU time is zero.
 */
export function limitsFromSettings(cpuMs: unknown, subRequests: unknown): DispatchLimits | null {
  if (typeof cpuMs !== "string" || typeof subRequests !== "string") return null;
  if (!DECIMAL.test(cpuMs) || !DECIMAL.test(subRequests)) return null;
  const cpu = Number(cpuMs);
  if (cpu < 1) return null;
  return { cpuMs: cpu, subRequests: Number(subRequests) };
}
