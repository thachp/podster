/** The session paths a browser may use through this host. Agent Auth, capabilities and MCP stay on the gateway's host. */
const PERSON_AUTH = [/^\/api\/auth\/sign-in\/(social|email|magic-link)$/, /^\/api\/auth\/magic-link\/verify$/, /^\/api\/auth\/sign-up\/email$/, /^\/api\/auth\/sign-out$/, /^\/api\/auth\/callback\/[\w-]+$/, /^\/api\/auth\/get-session$/, /^\/api\/auth\/error$/];
const DASHBOARD = [/^\/api\/v1\//, /^\/api\/orgs$/, /^\/api\/orgs\/org_[\w-]+\/(members|invitations)(\/[\w-]+)?$/, /^\/api\/org-invitations\/(preview|accept)$/, /^\/api\/agents(\/|$)/, /^\/api\/consent$/, /^\/api\/claim$/];

export function isForwardable(path: string) {
  // A collapsed slash or dot segment could reach something the gateway's prefix checks didn't look at.
  if (path.includes("//") || path.includes("/./") || path.includes("/../") || /%2f|%5c|%2e/i.test(path)) return false;
  // A file's bytes have their own route, because this path reads a body whole. Near misses get no further than a refusal.
  if (path.startsWith("/api/v1/uploads")) return false;
  return PERSON_AUTH.some((route) => route.test(path)) || DASHBOARD.some((route) => route.test(path));
}

export const ORG_COOKIE = "podster-org";

export const readCookie = (header: string | null, name: string) =>
  header
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1) || null;

/**
 * Only what the gateway needs. `origin` stays the browser's own, so the gateway's check still means something, and the
 * organization comes from our cookie: the gateway checks it against the person's memberships either way.
 */
export function forwardedHeaders(incoming: Headers) {
  const headers = new Headers();
  for (const name of ["cookie", "content-type", "accept", "idempotency-key", "origin", "sec-fetch-site", "cf-connecting-ip", "user-agent"]) {
    const value = incoming.get(name);
    if (value) headers.set(name, value);
  }
  const org = readCookie(incoming.get("cookie"), ORG_COOKIE);
  if (org) headers.set("x-podster-org", org);
  return headers;
}

/**
 * The largest body a dashboard route takes is one command, whose fields together stay under 200 KB, so this leaves room
 * for JSON escaping and still keeps an anonymous caller from making this Worker hold an unbounded body.
 */
export const MAX_FORWARDED_BODY_BYTES = 1024 * 1024;

/** Reads the stream as well as trusting the header, because a chunked body has no length. Null once it passes the limit. */
export async function boundedBody(request: Request, limit: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null && !(Number(declared) <= limit)) {
    await request.body?.cancel().catch(() => undefined);
    return null;
  }
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

const tooLarge = () => Response.json({ error: { code: "body_too_large", message: "body_too_large" } }, { status: 413, headers: { "cache-control": "no-store" } });

/** The only way browser code reaches anything behind this Worker. The gateway authenticates, and Rust decides. */
export async function forwardToGateway(request: Request, gateway: Pick<Fetcher, "fetch">, appUrl: string): Promise<Response> {
  const url = new URL(request.url);
  if (!isForwardable(url.pathname)) return Response.json({ error: { code: "not_found", message: "not_found" } }, { status: 404 });
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const sent = forwardedHeaders(request.headers);
  // Only here, where the gateway checks a sign-in link came from its landing page. A referrer can hold anything otherwise.
  const referer = request.headers.get("referer");
  if (url.pathname === "/api/auth/magic-link/verify" && referer) sent.set("referer", referer);
  const body = hasBody ? await boundedBody(request, MAX_FORWARDED_BODY_BYTES) : undefined;
  if (body === null) return tooLarge();
  const response = await gateway.fetch(new URL(url.pathname + url.search, appUrl).toString(), {
    method: request.method,
    headers: sent,
    body,
    redirect: "manual",
  });
  // Set-Cookie and Location pass through, so a session and a provider's redirect land on this host.
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  return new Response(response.body, { status: response.status, headers });
}
