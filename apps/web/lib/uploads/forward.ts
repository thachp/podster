const UPLOAD_PATH = /^\/api(\/v1\/uploads\/[\w-]+\/[\w-]+)$/;

const answer = (code: string, status: number) => Response.json({ error: { code, message: code } }, { status, headers: { "cache-control": "no-store" } });

/**
 * A file's bytes on their way to the gateway, unread. The token is the only authority here, so the session cookie goes no
 * further than this host, and neither does anything else a page could set.
 */
export async function forwardUpload(request: Request, gateway: Pick<Fetcher, "fetch">, appUrl: string): Promise<Response> {
  const path = new URL(request.url).pathname.match(UPLOAD_PATH)?.[1];
  if (!path) return answer("not_found", 404);
  const headers = new Headers();
  for (const name of ["authorization", "cf-connecting-ip"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  let response: Response;
  try {
    response = await gateway.fetch(new URL(path, appUrl).toString(), { method: "PUT", headers, body: request.body, redirect: "manual" });
  } catch {
    // The token still works, so this has to read as something to try again, not as vinext's empty 500.
    return answer("upstream_unavailable", 502);
  }
  const answered = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) answered.set("retry-after", retryAfter);
  return new Response(response.body, { status: response.status, headers: answered });
}
