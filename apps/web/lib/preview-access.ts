import { forwardedHeaders } from "./gateway/forward";
import { signInPath, secondsToWait, RATE_LIMITED_PATH } from "./gateway/server";
import { CSP } from "./security-headers";

/**
 * The application host's `/preview-access` page (M8 step 7; docs/m8-preview-plan.md, 5.3, steps 2 and 4). A preview host
 * sends a browser here with `host`, `st` and `r` in the query, none of them a credential. Signed out, the person signs in
 * and comes back. Signed in, this asks the gateway for a ticket, and the API decides (`requestPreviewAccess`). Granted,
 * it sends the browser on with a `303` to the address the API returned, whose ticket and session token are **only in the
 * fragment**: never in this page's query or path, never in a log, never in a `Referer` (`Referrer-Policy: no-referrer`),
 * never cached (`Cache-Control: no-store`). Refused, it shows one page for every refusal, as the API answers one code.
 *
 * Every flow starts on the preview host, so a request without `st` is refused here and never asks anyone. Nothing here
 * logs, and nothing reads the answer but to check where it sends the browser.
 */

/** The answers this page gives, each never stored and never sent on as a `Referer`. */
const OWN_HEADERS: Record<string, string> = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "content-security-policy": CSP,
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
};

const HOST = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;
const STATE_HASH = /^[A-Za-z0-9_-]{43}$/;
const MAX_RETURN_PATH = 2048;

/** Where on the preview host to come back to: one leading `/`, then visible ASCII, as the API's own check. */
const returnPathOk = (r: string) => r.length >= 1 && r.length <= MAX_RETURN_PATH && r.startsWith("/") && !/^\/[/\\]/.test(r) && /^[\x21-\x7e]+$/.test(r);

/** The answer's address must be `https://<the host asked for>/__podster/enter#...`, with no query. */
export function enterAddressOk(redirect: unknown, host: string): redirect is string {
  if (typeof redirect !== "string" || redirect.length > 8192) return false;
  const hash = redirect.indexOf("#");
  if (hash < 0) return false;
  const before = redirect.slice(0, hash);
  if (before !== `https://${host}/__podster/enter`) return false;
  const fragment = new URLSearchParams(redirect.slice(hash + 1));
  return [...fragment.keys()].join() === "t,s,r" && !!fragment.get("t") && !!fragment.get("s");
}

const page = (status: number, title: string, text: string) =>
  new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>${title}</title></head><body><main><h1>${title}</h1><p>${text}</p><p><a href="/attention">Back to Podster</a></p></main></body></html>`, {
    status,
    headers: { ...OWN_HEADERS, "content-type": "text/html; charset=utf-8" },
  });

const go = (location: string) => new Response(null, { status: 303, headers: { ...OWN_HEADERS, location } });

const refused = () => page(404, "You can't open this preview", "This preview doesn't exist, or you don't have access to it. Ask the workroom's owner if you think you should.");
const notFromPreview = () => page(400, "This link didn't come from a preview", "Open the preview from its own address, and it will bring you here.");

/** `GET /preview-access?host=&st=&r=`. `gateway` is the gateway's binding; `appUrl` this application's own origin. */
export async function previewAccess(request: Request, gateway: Pick<Fetcher, "fetch">, appUrl: string): Promise<Response> {
  const url = new URL(request.url);
  const host = url.searchParams.get("host") ?? "";
  const st = url.searchParams.get("st") ?? "";
  const r = url.searchParams.get("r") ?? "/";
  if (!HOST.test(host) || !STATE_HASH.test(st) || !returnPathOk(r)) return notFromPreview();

  const sent = forwardedHeaders(request.headers);
  for (const name of ["origin", "content-type", "sec-fetch-site", "idempotency-key"]) sent.delete(name);
  const session = await gateway.fetch(new URL("/api/auth/get-session?disableRefresh=true", appUrl).toString(), { headers: sent });
  if (session.status === 429) return go(`${RATE_LIMITED_PATH}?after=${secondsToWait(session.headers.get("retry-after")) ?? 60}`);
  if (session.status >= 500) return page(503, "Podster isn't answering", "Try again in a moment.");
  const signedIn = session.ok && (await session.json().catch(() => null)) !== null;
  if (!signedIn) return go(signInPath(url.pathname + url.search));

  // This host's own write, made here: a top-level navigation from a preview carries no `Origin`, and the gateway's
  // check is that a write comes from this application, which this is.
  const asked = new Headers(sent);
  asked.set("content-type", "application/json");
  asked.set("origin", new URL(appUrl).origin);
  const answer = await gateway.fetch(new URL("/api/v1/preview-access", appUrl).toString(), { method: "POST", headers: asked, body: JSON.stringify({ host, st, r }), redirect: "manual" });
  if (answer.status === 429) return go(`${RATE_LIMITED_PATH}?after=${secondsToWait(answer.headers.get("retry-after")) ?? 60}`);
  if (!answer.ok) return answer.status >= 500 ? page(503, "Podster isn't answering", "Try again in a moment.") : refused();
  const redirect = ((await answer.json().catch(() => null)) as { redirect?: unknown } | null)?.redirect;
  // Only the address the API returned, and only if it is the host asked for: never one taken from the query.
  if (!enterAddressOk(redirect, host)) return refused();
  return go(redirect);
}
