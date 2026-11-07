const UPLOAD_PATH = /^\/api(\/v1\/uploads\/[\w-]+\/[\w-]+)$/;

/**
 * A file's bytes on their way to the gateway, unread. The token is the only authority here, so the session cookie goes no
 * further than this host, and neither does anything else a page could set.
 */
export async function forwardUpload(request: Request, gateway: Pick<Fetcher, "fetch">, appUrl: string): Promise<Response> {
  const path = new URL(request.url).pathname.match(UPLOAD_PATH)?.[1];
  if (!path) return Response.json({ error: { code: "not_found", message: "not_found" } }, { status: 404 });
  const headers = new Headers();
  for (const name of ["authorization", "cf-connecting-ip"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const response = await gateway.fetch(new URL(path, appUrl).toString(), { method: "PUT", headers, body: request.body, redirect: "manual" });
  return new Response(response.body, { status: response.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
