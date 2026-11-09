// The per-client limit on the signed-out room page and on Explore (ADR 0008, M4-10). Cloudflare's rate-limit binding is
// approximate, and this is the one limit that fails open when the limiter fails, as the plan says. The client address comes
// from `cf-connecting-ip`, which step 14 checks the edge overwrites. Neither the address nor the key is ever logged.

export type RateLimiter = { limit(options: { key: string }): Promise<{ success: boolean }> };

/** True when this client may go on. No address, or a limiter that fails, lets the request through. */
export async function underLimit(limiter: RateLimiter | undefined, address: string | null): Promise<boolean> {
  if (!limiter || !address) return true;
  try {
    return (await limiter.limit({ key: address })).success;
  } catch {
    console.error("public page limiter failed");
    return true;
  }
}
