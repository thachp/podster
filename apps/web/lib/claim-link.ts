/**
 * The Agent Auth plugin builds an approval link as `/claim?agent_id=…&code=…`, and can't be told otherwise. The first request
 * that carries the code moves it into this cookie, scoped to `/claim`, and sends the browser to the bare page, so the code
 * isn't left in the address bar, the history entry, sign-in's `next`, a Referer, or the URL of the page's read. The page's
 * read forwards the cookie, and the gateway takes the link from it (`claimLink` in apps/gateway/src/index.ts, which writes the
 * same cookie on its own host).
 */
export const CLAIM_COOKIE = "podster-claim";
const CLAIM_COOKIE_SECONDS = 600;
// A plugin's agent ID and code are far shorter. Anything longer isn't a real link, and a cookie that size could be dropped.
const MAX_CLAIM_COOKIE_LENGTH = 512;

/** The move, for a GET of `/claim` whose query has a code. Null for anything else. */
export function claimLinkMoved(url: URL, method: string): Response | null {
  if (method !== "GET" || url.pathname !== "/claim" || !url.searchParams.has("code")) return null;
  const value = encodeURIComponent(new URLSearchParams({ agent_id: url.searchParams.get("agent_id") ?? "", code: url.searchParams.get("code") ?? "" }).toString());
  const headers = new Headers({ location: "/claim", "referrer-policy": "no-referrer", "cache-control": "no-store" });
  const secure = url.protocol === "https:" ? "; Secure" : "";
  // Too long to be real: the bare page then says the link isn't valid, which it isn't.
  if (value.length <= MAX_CLAIM_COOKIE_LENGTH) headers.set("set-cookie", `${CLAIM_COOKIE}=${value}; Path=/claim; Max-Age=${CLAIM_COOKIE_SECONDS}; HttpOnly; SameSite=Lax${secure}`);
  return new Response(null, { status: 303, headers });
}
