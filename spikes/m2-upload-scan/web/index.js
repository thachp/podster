// The application's shape: it reaches the gateway only through a service binding, and passes the body along unread.
export default {
  async fetch(request, env) {
    if (!env.SPIKE_TOKEN || request.headers.get("x-spike-token") !== env.SPIKE_TOKEN) return new Response("Not found", { status: 404 });
    const started = Date.now();
    const headers = new Headers(request.headers);
    headers.delete("x-spike-token");
    const response = await env.GATEWAY.fetch(new Request(request.url, { method: request.method, headers, body: request.body }));
    console.log(JSON.stringify({ at: "web", status: response.status, ms: Date.now() - started }));
    return response;
  },
};
