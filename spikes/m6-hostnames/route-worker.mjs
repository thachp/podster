// Spike D's test Worker, routed `*/*` on the content zone for a few minutes. No bindings, no secrets, no logging.
// `make-route-worker.sh` copies this into the scratchpad with __KEY__ replaced by a random key held only there.
//
// Any request: a short JSON answer naming the request's host as the Worker sees it, and the few `cf` fields that
// bear on spike D. `/doh/<key>`: the same fixed DNS-over-HTTPS questions the runner asks from outside.

const KEY = "__KEY__";
const NAMES = [
  ["_cf-custom-hostname.spike.opster.dev", "TXT"],
  ["nothing-here-spike-d.invalid", "TXT"],
  ["_dmarc.podster.dev", "TXT"],
  ["cloudflare.com", "TXT"],
  ["dnssec-failed.org", "TXT"],
  ["www.github.com", "TXT"],
];
const RESOLVERS = {
  cloudflare: (n, t) => `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(n)}&type=${t}`,
  "cloudflare-1.1.1.1": (n, t) => `https://1.1.1.1/dns-query?name=${encodeURIComponent(n)}&type=${t}`,
  google: (n, t) => `https://dns.google/resolve?name=${encodeURIComponent(n)}&type=${t}`,
};

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const cf = request.cf ?? {};
    const facts = {
      spike: "m6-hostnames-route",
      url_host: url.host,
      host_header: request.headers.get("host"),
      scheme: url.protocol,
      colo: cf.colo ?? null,
      tls_version: cf.tlsVersion ?? null,
      http_protocol: cf.httpProtocol ?? null,
      host_metadata: cf.hostMetadata ?? null,
      cf_keys: Object.keys(cf).sort(),
    };
    if (url.pathname !== `/doh/${KEY}`) return Response.json(facts);
    const out = [];
    for (const [name, type] of NAMES) {
      for (const [which, make] of Object.entries(RESOLVERS)) {
        const started = Date.now();
        try {
          const res = await fetch(make(name, type), { headers: { accept: "application/dns-json" } });
          const text = await res.text();
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {}
          out.push({ resolver: which, name, type, http: res.status, ctype: res.headers.get("content-type"), json, head: json ? undefined : text.slice(0, 80), ms: Date.now() - started });
        } catch (e) {
          out.push({ resolver: which, name, type, error: String(e?.message ?? e), ms: Date.now() - started });
        }
      }
    }
    return Response.json({ ...facts, doh: out });
  },
};
