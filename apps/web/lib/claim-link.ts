/**
 * The Agent Auth plugin builds an approval link as `/claim?agent_id=…&code=…`, and can't be told otherwise. The first request
 * that carries the code moves it into this cookie and sends the browser to the bare page, so the code isn't left in the
 * address bar, the history entry, sign-in's `next`, a Referer, or the URL of the page's read. The page's read forwards the
 * cookie, and the gateway takes the link from it; a successful claim or a decline clears it (`claimLink` and
 * `claimCookieCleared` in apps/gateway/src/index.ts, which writes the same cookie on its own host).
 *
 * `__Host-` makes the browser hold it to this host, over HTTPS, at `Path=/`. It's HttpOnly, so the wider path shows it to
 * no script. A browser on plain `http://localhost` gets a plain name instead, which the gateway reads only there, so local
 * runs work; plain HTTP anywhere else gets no cookie.
 */
export const CLAIM_COOKIE = "__Host-podster-claim";
export const LOCAL_CLAIM_COOKIE = "podster-claim-local";
const CLAIM_COOKIE_SECONDS = 600;
// A plugin's agent ID and code are far shorter. Anything longer isn't a real link, and a cookie that size could be dropped.
const MAX_CLAIM_COOKIE_LENGTH = 512;

const isLocalHttp = (url: URL) => url.protocol === "http:" && (url.hostname === "localhost" || url.hostname.endsWith(".localhost") || url.hostname === "127.0.0.1" || url.hostname === "[::1]");

/** The cookie holding a link, or, with no value, the one clearing it. Null where none may be set. */
function claimCookie(url: URL, value?: string) {
  const name = url.protocol === "https:" ? CLAIM_COOKIE : isLocalHttp(url) ? LOCAL_CLAIM_COOKIE : null;
  if (!name) return null;
  return `${name}=${value ?? ""}; Path=/; Max-Age=${value === undefined ? 0 : CLAIM_COOKIE_SECONDS}; HttpOnly; SameSite=Lax${name === CLAIM_COOKIE ? "; Secure" : ""}`;
}

/** The move, for a GET of `/claim` whose query has a code. Null for anything else. */
export function claimLinkMoved(url: URL, method: string): Response | null {
  if (method !== "GET" || url.pathname !== "/claim" || !url.searchParams.has("code")) return null;
  const value = encodeURIComponent(new URLSearchParams({ agent_id: url.searchParams.get("agent_id") ?? "", code: url.searchParams.get("code") ?? "" }).toString());
  const headers = new Headers({ location: "/claim", "referrer-policy": "no-referrer", "cache-control": "no-store" });
  // Too long to be real: the bare page then says the link isn't valid, and the last link's cookie is cleared, so an older
  // pending agent can't be shown in its place.
  const cookie = claimCookie(url, value.length <= MAX_CLAIM_COOKIE_LENGTH ? value : undefined);
  if (cookie) headers.set("set-cookie", cookie);
  return new Response(null, { status: 303, headers });
}
