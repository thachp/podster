// M6 spike A: a dispatch Worker in front of the staging dispatch namespace.
// It routes /<script name>/<path> to that script and reports what a failed
// dispatch looks like. It holds no secret and no binding but the namespace.

const json = (status, body) =>
  new Response(JSON.stringify(body, null, 2) + "\n", {
    status,
    headers: { "content-type": "application/json", "x-spike-dispatch": "own-answer" },
  });

export default {
  async fetch(request, env) {
    // Cloudflare calls the outbound Worker for each fetch() a user Worker makes,
    // with the binding's parameters on env. This Worker is its own outbound Worker.
    if (env.spike_outbound !== undefined) return outbound(request, env);

    const url = new URL(request.url);
    const match = url.pathname.match(/^\/([^/]+)(\/.*)?$/);
    if (!match) return json(200, { spike: "m6-a", usage: "/<script name>/<path>" });

    const name = decodeURIComponent(match[1]);
    url.pathname = match[2] ?? "/";
    const mode = url.searchParams.get("__outbound");
    const fixHeaders = url.searchParams.has("__fix");
    url.searchParams.delete("__outbound");
    url.searchParams.delete("__fix");

    let stage = "get";
    try {
      const worker =
        mode === null
          ? env.DISPATCH.get(name)
          : env.DISPATCH.get(name, {}, { outbound: { spike_outbound: mode } });
      stage = "fetch";
      const response = await worker.fetch(new Request(url, request));
      const out = new Response(response.body, response);
      out.headers.set("x-spike-dispatch", "user-worker-answer");
      if (fixHeaders) {
        // What ADR 0010's content Worker would do: set its own headers last.
        out.headers.delete("set-cookie");
        out.headers.delete("content-security-policy");
        out.headers.set("cache-control", "public, max-age=60");
        out.headers.set("referrer-policy", "no-referrer");
        out.headers.set("x-content-type-options", "nosniff");
      }
      return out;
    } catch (error) {
      return json(502, {
        dispatch_error: { stage, name: error?.name, message: error?.message },
      });
    }
  },
};

async function outbound(request, env) {
  const url = new URL(request.url);
  const seen = { mode: env.spike_outbound, method: request.method, host: url.host, path: url.pathname };
  if (env.spike_outbound === "pass") {
    const response = await fetch(request);
    const out = new Response(response.body, response);
    out.headers.set("x-spike-outbound", "passed");
    return out;
  }
  if (url.host === "example.org") {
    return new Response(JSON.stringify({ answered_by: "the outbound Worker", seen }), {
      headers: { "content-type": "application/json", "x-spike-outbound": "routed" },
    });
  }
  return new Response(JSON.stringify({ blocked_by: "the outbound Worker", seen }), {
    status: 403,
    headers: { "content-type": "application/json", "x-spike-outbound": "blocked" },
  });
}
