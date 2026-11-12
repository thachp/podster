import { connect } from "cloudflare:sockets";

const brief = (error) => ({ threw: error?.name, message: String(error?.message).slice(0, 200) });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const report = {
      env_keys: Object.keys(env),
      request_cf: request.cf === undefined ? "undefined" : Object.keys(request.cf),
      fetch: {},
    };

    try {
      const key = new Request("https://spike.invalid/cache-probe");
      await caches.default.put(key, new Response("x", { headers: { "cache-control": "max-age=60" } }));
      report.caches_default = { put: "no error", match: (await caches.default.match(key)) ? "hit" : "miss" };
    } catch (error) {
      report.caches_default = brief(error);
    }

    for (const target of url.searchParams.getAll("t")) {
      try {
        const response = await fetch(target, { redirect: "manual" });
        report.fetch[target] = {
          status: response.status,
          server: response.headers.get("server"),
          outbound: response.headers.get("x-spike-outbound"),
          body: (await response.text()).slice(0, 160),
        };
      } catch (error) {
        report.fetch[target] = brief(error);
      }
    }

    report.tcp = [];
    for (const tcp of url.searchParams.getAll("tcp")) {
      let stage = "connect";
      try {
        const socket = connect(tcp);
        stage = "opened";
        await socket.opened;
        stage = "write";
        const writer = socket.writable.getWriter();
        await writer.write(new TextEncoder().encode(`HEAD / HTTP/1.0\r\nHost: ${tcp.split(":")[0]}\r\n\r\n`));
        stage = "read";
        const { value } = await socket.readable.getReader().read();
        report.tcp.push({ target: tcp, first_line: new TextDecoder().decode(value).split("\r\n")[0] });
        await socket.close();
      } catch (error) {
        report.tcp.push({ target: tcp, stage, ...brief(error) });
      }
    }

    return new Response(JSON.stringify(report, null, 2) + "\n", {
      headers: { "content-type": "application/json" },
    });
  },
};
