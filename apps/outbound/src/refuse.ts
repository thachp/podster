// The outbound Worker's whole behaviour (M6 stage 1, ADR 0010's revision, question 8 and "Limits and outbound").
// Workers for Platforms calls it for every `fetch()` an app's code makes, and while it is set the app can't open a
// socket. It refuses every one: the same status, the same headers and the same fixed body, whatever was asked.
//
// It is given nothing of the request on purpose. It reads no method, URL, header or body, so nothing an app sends can
// change the answer or come back in it, and a large body is never read. It makes no request of its own, holds no
// binding, and logs nothing.

/** The one status every outbound request gets. */
export const REFUSED_STATUS = 403;

/** The one body, fixed. It names no host, path or header of the request. */
export const REFUSED_BODY = "outbound requests from apps are refused\n";

/** The one set of headers. */
export const REFUSED_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-type": "text/plain; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
});

/** A new refusal, built from nothing but the constants above. */
export function refuse(): Response {
  return new Response(REFUSED_BODY, { status: REFUSED_STATUS, headers: REFUSED_HEADERS });
}
