/**
 * Runner talks to one place: the gateway the owner named. Never the Rust API, which has no public route, and never a
 * host a response or a discovery document points at. Every request Runner or the SDK makes goes through `gatewayFetch`,
 * which refuses any other origin and never follows a redirect.
 */
import { GatewayError, readBounded } from "./errors.js";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The gateway's origin, from what the owner typed: `https://` and a host, with no path, query, fragment or credentials.
 * Plain `http://` only for a gateway on this machine, for local runs.
 */
export function gatewayOrigin(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("The gateway must be a URL such as https://podster.dev");
  }
  const local = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new Error("The gateway must use https://");
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("The gateway is an origin only, such as https://podster.dev, with no path");
  }
  return url.origin;
}

/**
 * The gateway Runner pairs with when the owner names none: Podster's staging gateway. Runner is published only as a test
 * pre-release for staging (the owner's decision of 2026-11-19, narrowing decision 26), and there is no production
 * deployment. `pair --gateway <origin>` still names another, such as a gateway on this machine.
 */
export const DEFAULT_GATEWAY = "https://gateway-staging.podster.dev";

/** The gateway `pair` uses: the one the owner named, or staging's, checked as `gatewayOrigin` checks any. */
export function pairingGateway(named: string | undefined): string {
  return gatewayOrigin(named ?? DEFAULT_GATEWAY);
}

/** Whether a URL is on the gateway's origin. */
export function onGateway(origin: string, target: string): boolean {
  try {
    return new URL(target).origin === origin;
  } catch {
    return false;
  }
}

/**
 * A fetch that reaches only the gateway's origin and never follows a redirect: a 3xx is refused, not followed. A
 * request it refuses never leaves the machine. The network failing reads as `GatewayError(0, "network")`.
 */
export function gatewayFetch(origin: string, fetchImpl: typeof fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const target = input instanceof Request ? input.url : String(input);
    if (!onGateway(origin, target)) throw new GatewayError(0, "wrong_origin");
    let response: Response;
    try {
      response = await fetchImpl(input instanceof Request ? input : target, { ...init, redirect: "manual" });
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      throw new GatewayError(0, "network");
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new GatewayError(response.status, "redirect_refused");
    }
    return response;
  }) as typeof fetch;
}

/**
 * A fetch for the pinned SDK, which reads every answer whole with `json()`: each answer's body is read here first, only
 * up to `max` bytes, the rest cancelled, and the SDK gets that text. A successful answer past the bound, or one that
 * never ends, is refused as `bad_answer`; a refusal's body past it reaches the SDK empty, with its status (review L3 on
 * #461).
 */
export function boundedBodies(reach: typeof fetch, max: number): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await reach(input, init);
    const text = await readBounded(response, max);
    if (text === null && response.ok) throw new GatewayError(0, "bad_answer");
    const headers = new Headers();
    const type = response.headers.get("content-type");
    if (type !== null) headers.set("content-type", type);
    const retry = response.headers.get("retry-after");
    if (retry !== null) headers.set("retry-after", retry);
    return new Response(response.status === 204 || text === "" ? null : text, { status: response.status, headers });
  }) as typeof fetch;
}
