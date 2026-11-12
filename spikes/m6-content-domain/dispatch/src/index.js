// Spike only. M6 spike C's dispatch Worker: hands each opster.dev host to its app in the namespace. Logs nothing.
import { headerChanges, parseHost, preflight } from "./route.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const target = parseHost(url.hostname);
    if (!target) return new Response("not found\n", { status: 404 });

    const early = preflight(target, {
      method: request.method,
      pathname: url.pathname,
      serviceWorker: request.headers.get("service-worker"),
      cookie: request.headers.get("cookie"),
    });
    if (early) return new Response(early.body, { status: early.status, headers: { ...early.headers, "x-spike-mode": target.mode } });

    let res;
    try {
      res = await env.NS.get(target.script, {}, { limits: { cpuMs: 50 } }).fetch(request);
    } catch (e) {
      return Response.json({ dispatchError: true, name: e.name, message: String(e.message).slice(0, 200) }, { status: 502 });
    }

    const out = new Response(res.body, res);
    const { remove, set } = headerChanges(target.mode, url.origin);
    for (const name of remove) out.headers.delete(name);
    for (const [name, value] of Object.entries(set)) out.headers.set(name, value);
    out.headers.set("x-spike-mode", target.mode);
    return out;
  },
};
