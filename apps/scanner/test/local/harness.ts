/**
 * The real queue handler, real local R2 and the real Container, with a stand-in for the API. Only `run-local.mjs` uses it, because
 * `wrangler dev` needs Docker and current signatures. The API's own route comes with storage.
 */
import scanner, { ClamAV, type Env } from "../../src/index";

export { ClamAV };

type Harness = Env & { SCAN: Queue<unknown>; RESULTS: KVNamespace };

export default {
  async fetch(request: Request, env: Harness) {
    const url = new URL(request.url);
    if (url.pathname === "/internal/scan-result") {
      const result = await request.json<{ object_id: string }>();
      await env.RESULTS.put(result.object_id, JSON.stringify({ result, secret: request.headers.get("x-podster-scanner"), idempotency: request.headers.get("idempotency-key") }));
      return Response.json({ state: "recorded" });
    }
    if (url.pathname === "/put") {
      await env.ASSETS.put(url.searchParams.get("key")!, request.body, { httpMetadata: {} });
      return new Response("stored");
    }
    if (url.pathname === "/send") {
      await env.SCAN.send(await request.json());
      return new Response("sent");
    }
    if (url.pathname === "/result") return new Response((await env.RESULTS.get(url.searchParams.get("id")!)) ?? "null");
    return new Response("not found", { status: 404 });
  },
  queue: scanner.queue,
};
