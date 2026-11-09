// The per-client limit on the signed-out room page and on Explore (ADR 0008, M4-10). Cloudflare's rate-limit binding is
// approximate, and this is the one limit that fails open when the limiter fails, as the plan says. The client address comes
// from `cf-connecting-ip`, which step 14 checks the edge overwrites. Neither the address nor the key is ever logged.

export type RateLimiter = { limit(options: { key: string }): Promise<{ success: boolean }> };

const WORKER_SUBREQUEST_IP = "2a06:98c0:3600::103";

/**
 * Who a request counts as. A copy of `clientKey` in `apps/gateway/src/index.ts`, since the packages share no code: keep the
 * two the same. An IPv6 client controls a whole /64, so it counts as one. Cloudflare gives every request from another zone's
 * Worker one address and names the zone in `cf-worker`, so each zone counts as its own client.
 */
export function clientKey(headers: Pick<Headers, "get">): string {
  const ip = headers.get("cf-connecting-ip") ?? "unknown";
  if (ip === WORKER_SUBREQUEST_IP) return `worker:${headers.get("cf-worker") ?? "unknown"}`;
  if (!ip.includes(":")) return ip;
  const [head, tail = ""] = ip.toLowerCase().split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  return groups.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, "")).join(":");
}

/** True when this client may go on. A limiter that's missing or fails lets the request through. */
export async function underLimit(limiter: RateLimiter | undefined, request: { headers: Pick<Headers, "get"> }): Promise<boolean> {
  if (!limiter) return true;
  try {
    return (await limiter.limit({ key: clientKey(request.headers) })).success;
  } catch {
    console.error("public page limiter failed");
    return true;
  }
}
