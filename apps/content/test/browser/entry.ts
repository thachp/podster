// **The browser run's entry, and nothing else's** (`e2e/content-sandbox.mjs`, M6 step 4(b)). It runs the content
// Worker's real handler, `src/handle.ts`, in the real Workers runtime under `wrangler dev`, with what a deployment
// would get from its two bindings held in memory here: two apps' serve entries, and one small static app as the
// "namespace". Nothing in `src/` imports this, and no configuration but the browser run's names it.
//
// The browser never reaches this by a real name or over real TLS. The run intercepts each request the browser makes
// and asks this entry instead, with the address the browser asked for in one header. So the handler sees the request
// as a deployment would see it, with that address as its URL.
import { handle, type StopMemory } from "../../src/handle";
import { FILES } from "./app-files";

/** A domain under `.example`, which nobody can hold. */
const DOMAIN = "sandbox-test.example";
/** Two apps, each on its own default host, each serving the same small app from a script under its own label. */
const ENTRIES: Record<string, string> = {
  [`appa.${DOMAIN}`]: `appa.rel_${"a".repeat(32)}`,
  [`appb.${DOMAIN}`]: `appb.rel_${"b".repeat(32)}`,
};
/** The header the run puts the browser's address in. Only the run sends it. */
const ASKED = "x-content-browser-run-url";

const stop: StopMemory = { read: null };

/** One app's answer, as a release's static files would answer, with two headers no visitor should ever see. */
function serve(script: string, request: Request): Response {
  if (!Object.values(ENTRIES).includes(script)) throw new Error("Worker not found.");
  const file = FILES[new URL(request.url).pathname];
  const headers = new Headers({ "set-cookie": `from-app=1; Path=/; Domain=${DOMAIN}`, "x-app-header": "set by the app" });
  if (!file) return new Response("no such file\n", { status: 404, headers });
  headers.set("content-type", file.type);
  headers.set("etag", `"${file.body.byteLength}"`);
  return new Response(file.body, { headers });
}

export default {
  async fetch(request: Request): Promise<Response> {
    const asked = request.headers.get(ASKED);
    if (asked === null) return new Response("the content Worker's browser run: not a deployment\n", { status: 400 });
    const headers = new Headers(request.headers);
    headers.delete(ASKED);
    return handle(new Request(asked, { method: request.method, headers }), {
      entries: { get: async (key) => ENTRIES[key] ?? null },
      apps: { get: (script) => ({ fetch: async (toApp) => serve(script, toApp) }) },
      now: () => Date.now(),
      stop,
      domain: DOMAIN,
    });
  },
} satisfies ExportedHandler;
