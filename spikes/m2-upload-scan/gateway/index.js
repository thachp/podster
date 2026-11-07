// The gateway's shape: refuse what's too big before reading a byte, then pass the body along unread. The API counts for real.
const MAX_FILE_BYTES = 100_000_000;

export default {
  async fetch(request, env) {
    const started = Date.now();
    if (request.method === "PUT") {
      const declared = request.headers.get("content-length");
      if (declared === null) return Response.json({ error: "length_required" }, { status: 411 });
      if (!/^\d+$/.test(declared) || Number(declared) > MAX_FILE_BYTES) return Response.json({ error: "too_large" }, { status: 413 });
    }
    const response = await env.API.fetch(new Request(request.url, { method: request.method, headers: request.headers, body: request.body }));
    console.log(JSON.stringify({ at: "gateway", status: response.status, ms: Date.now() - started }));
    return response;
  },
};
